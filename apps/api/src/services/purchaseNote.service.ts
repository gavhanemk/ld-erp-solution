import type { Prisma } from '@prisma/client'
import { PurchaseNoteEffect, PurchaseNoteReason, PurchaseNoteType } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { recordMovement } from './stock.service'

/**
 * What a debit or credit note against a supplier actually means.
 *
 * The rules live here rather than in the route because three callers need the
 * same answers: the form, which asks what is still adjustable before the user
 * types; the save, which refuses anything over that; and the posting, which
 * moves the money and the goods. Three copies of this arithmetic would have
 * disagreed by the second change.
 */

const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000

// ── What happened → what the document is ────────────────────────────────────

/**
 * The one table that turns a purchase office's words into an accounting
 * position.
 *
 * A buyer is asked what happened — cloth came back, the rate was wrong, a roll
 * never arrived. They are never asked whether that is a debit or a credit,
 * because that is not knowledge they have and getting it wrong moves money the
 * wrong way. This maps the first onto the second, in one place, where it can be
 * read and argued with.
 *
 * `type` is only the *default*. A purchase return normally means we raise a
 * debit note; if the supplier got there first and sent their own credit note,
 * the same reason is recorded against their document instead. The form offers
 * the default and lets it be changed, which is exactly the separation of
 * business reason from document type that the accounts desk asked for.
 */
export const REASON_RULES: Record<
  PurchaseNoteReason,
  {
    /** What the purchase office would call it. */
    label: string
    /** One line under the option, in the words of the thing that happened. */
    hint: string
    /** The document this usually becomes. Overridable on the form. */
    type: PurchaseNoteType
    /** What it does to the payable. */
    effect: PurchaseNoteEffect
    /**
     * Whether material physically leaves the mill.
     *
     * A short delivery never arrived and a wrong rate is only ever paper, so
     * neither touches stock. A return, a rejection, a damaged lot and wrong
     * material all take goods off the rack — scrapped or sent back, they stop
     * being stock either way.
     */
    movesGoods: boolean
    /**
     * Whether the adjustment eats into the billed *quantity*.
     *
     * A rate correction of ₹5 on 100 metres is not a claim on 100 metres —
     * the cloth is still ours. Counting it against the quantity would make a
     * fully-priced line look fully returned and block the genuine return that
     * came after it.
     */
    consumesQty: boolean
  }
> = {
  PURCHASE_RETURN: {
    label: 'Material returned',
    hint: 'Goods went back to the supplier',
    type: 'DEBIT',
    effect: 'REDUCES_PAYABLE',
    movesGoods: true,
    consumesQty: true,
  },
  SHORT_QUANTITY: {
    label: 'Short quantity received',
    hint: 'Billed for more than actually arrived',
    type: 'DEBIT',
    effect: 'REDUCES_PAYABLE',
    movesGoods: false,
    consumesQty: true,
  },
  DAMAGED_MATERIAL: {
    label: 'Material damaged',
    hint: 'Arrived damaged and cannot be used',
    type: 'DEBIT',
    effect: 'REDUCES_PAYABLE',
    movesGoods: true,
    consumesQty: true,
  },
  QUALITY_REJECTION: {
    label: 'Rejected on quality',
    hint: 'Failed inspection — shade, GSM, finish',
    type: 'DEBIT',
    effect: 'REDUCES_PAYABLE',
    movesGoods: true,
    consumesQty: true,
  },
  WRONG_MATERIAL: {
    label: 'Wrong material sent',
    hint: 'Not what was ordered',
    type: 'DEBIT',
    effect: 'REDUCES_PAYABLE',
    movesGoods: true,
    consumesQty: true,
  },
  EXCESS_QUANTITY_BILLED: {
    label: 'Excess quantity billed',
    hint: 'The bill shows more than the challan',
    type: 'DEBIT',
    effect: 'REDUCES_PAYABLE',
    movesGoods: false,
    consumesQty: true,
  },
  RATE_DIFFERENCE: {
    label: 'Wrong rate charged',
    hint: 'Billed above the rate that was agreed',
    type: 'DEBIT',
    effect: 'REDUCES_PAYABLE',
    movesGoods: false,
    consumesQty: false,
  },
  EXCESS_BILLING: {
    label: 'Excess billing',
    hint: 'Charged for something not supplied',
    type: 'DEBIT',
    effect: 'REDUCES_PAYABLE',
    movesGoods: false,
    consumesQty: false,
  },
  POST_PURCHASE_DISCOUNT: {
    label: 'Discount after the bill',
    hint: 'The supplier agreed a reduction afterwards',
    type: 'CREDIT',
    effect: 'REDUCES_PAYABLE',
    movesGoods: false,
    consumesQty: false,
  },
  OTHER: {
    label: 'Something else',
    hint: 'Say what happened in your own words',
    type: 'DEBIT',
    effect: 'REDUCES_PAYABLE',
    movesGoods: false,
    consumesQty: false,
  },
}

/**
 * The statuses that still hold a claim on a bill line.
 *
 * A draft counts. Two drafts each claiming the whole line, both later approved,
 * is exactly the duplicate adjustment the accounts desk has to catch by hand
 * today — and the only moment it can be caught cheaply is while the second one
 * is being typed.
 */
export const LIVE_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED'] as const

// ── What is still adjustable ────────────────────────────────────────────────

export interface AdjustableLine {
  billLineId: string
  itemId: string
  itemCode: string
  itemName: string
  uom: string | null
  description: string | null
  hsnCode: string | null
  gstRate: number
  /** What the bill charged. */
  billedQty: number
  billedRate: number
  billedTaxable: number
  /** What notes already claim, across every note still standing. */
  adjustedQty: number
  adjustedValue: number
  /** What is left. Never below zero. */
  remainingQty: number
  remainingValue: number
}

/**
 * Line by line, what a bill has left to give.
 *
 * Two ceilings, not one, because they answer different questions. Quantity
 * stops a hundred metres being returned twice. Value stops a line being
 * claimed back for more than it was ever charged — which quantity alone does
 * not, since a return at an invented rate passes a quantity check comfortably.
 *
 * `excludeNoteId` is the note being edited. Without it, re-saving a note
 * without changing anything fails against its own earlier figures.
 */
export async function adjustableOn(
  tx: Prisma.TransactionClient,
  billId: string,
  excludeNoteId?: string
): Promise<AdjustableLine[]> {
  const bill = await tx.purchaseInvoice.findUnique({
    where: { id: billId },
    select: {
      id: true,
      lines: {
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          itemId: true,
          description: true,
          hsnCode: true,
          qty: true,
          unitPrice: true,
          taxableValue: true,
          gstRate: true,
          item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
        },
      },
    },
  })
  if (!bill) throw new AppError('That purchase bill no longer exists', 404, 'NOT_FOUND')

  const claims = await tx.purchaseNoteLine.findMany({
    where: {
      billLineId: { in: bill.lines.map((l) => l.id) },
      note: {
        status: { in: [...LIVE_STATUSES] },
        ...(excludeNoteId ? { id: { not: excludeNoteId } } : {}),
      },
    },
    select: {
      billLineId: true,
      qty: true,
      taxableValue: true,
      note: { select: { reason: true } },
    },
  })

  const byLine = new Map<string, { qty: number; value: number }>()
  for (const c of claims) {
    if (!c.billLineId) continue
    const at = byLine.get(c.billLineId) ?? { qty: 0, value: 0 }
    // Only a claim on the goods eats the quantity; a rate correction does not.
    if (REASON_RULES[c.note.reason].consumesQty) at.qty += Number(c.qty)
    at.value += Number(c.taxableValue)
    byLine.set(c.billLineId, at)
  }

  return bill.lines.map((l) => {
    const taken = byLine.get(l.id) ?? { qty: 0, value: 0 }
    const billedQty = Number(l.qty)
    const billedTaxable = Number(l.taxableValue)
    return {
      billLineId: l.id,
      itemId: l.itemId,
      itemCode: l.item.code,
      itemName: l.item.name,
      uom: l.item.uom?.symbol ?? null,
      description: l.description,
      hsnCode: l.hsnCode,
      gstRate: Number(l.gstRate),
      billedQty,
      billedRate: Number(l.unitPrice),
      billedTaxable,
      adjustedQty: round3(taken.qty),
      adjustedValue: round2(taken.value),
      remainingQty: round3(Math.max(0, billedQty - taken.qty)),
      remainingValue: round2(Math.max(0, billedTaxable - taken.value)),
    }
  })
}

// ── Pricing ─────────────────────────────────────────────────────────────────

export interface NoteLineInput {
  itemId: string
  billLineId?: string | null
  description?: string | null
  hsnCode?: string | null
  originalQty?: number | null
  originalRate?: number | null
  qty: number
  unitPrice: number
  gstRate: number
  remarks?: string | null
}

export interface PricedNoteLine extends NoteLineInput {
  taxableValue: number
  cgst: number
  sgst: number
  igst: number
  amount: number
}

function splitTax(taxable: number, gstRate: number, isIntraState: boolean) {
  const tax = round2(taxable * (gstRate / 100))
  return isIntraState
    ? { cgst: round2(tax / 2), sgst: round2(tax / 2), igst: 0 }
    : { cgst: 0, sgst: 0, igst: tax }
}

/**
 * Prices the note the way the bill it corrects was priced.
 *
 * The tax on an adjustment follows the goods it adjusts: the same rate and the
 * same intra- or inter-state split the supplier used. A note that re-decided
 * the split from today's master data would correct a CGST bill with an IGST
 * credit, and the difference would sit on the return unreconciled.
 */
export function priceNote(opts: {
  lines: NoteLineInput[]
  isIntraState: boolean
  otherCharges?: number
  discountAmount?: number
}): {
  lines: PricedNoteLine[]
  taxableAmount: number
  cgst: number
  sgst: number
  igst: number
  otherCharges: number
  discountAmount: number
  roundOff: number
  totalAmount: number
} {
  const { isIntraState } = opts
  const otherCharges = round2(opts.otherCharges ?? 0)
  const discountAmount = round2(opts.discountAmount ?? 0)

  const lines: PricedNoteLine[] = opts.lines.map((l) => {
    const taxableValue = round2(l.qty * l.unitPrice)
    const split = splitTax(taxableValue, l.gstRate, isIntraState)
    return {
      ...l,
      taxableValue,
      ...split,
      amount: round2(taxableValue + split.cgst + split.sgst + split.igst),
    }
  })

  const taxableAmount = round2(lines.reduce((s, l) => s + l.taxableValue, 0))
  const cgst = round2(lines.reduce((s, l) => s + l.cgst, 0))
  const sgst = round2(lines.reduce((s, l) => s + l.sgst, 0))
  const igst = round2(lines.reduce((s, l) => s + l.igst, 0))

  const before = taxableAmount + cgst + sgst + igst + otherCharges - discountAmount
  const totalAmount = Math.round(before)

  return {
    lines,
    taxableAmount,
    cgst,
    sgst,
    igst,
    otherCharges,
    discountAmount,
    roundOff: round2(totalAmount - before),
    totalAmount,
  }
}

// ── What a note does to the bill ────────────────────────────────────────────

/**
 * Re-reads a bill's adjustment from its posted notes and rewrites the balance.
 *
 * Summed from the notes, never incremented, for the same reason `paidAmount`
 * is: a running total drifts the first time a note is cancelled, and then two
 * numbers both claim to be the payable. Only POSTED notes count — a note
 * waiting for approval has changed nothing yet, and showing it as though it
 * had is how a supplier gets short-paid against an adjustment nobody agreed.
 *
 * Deliberately mirrors `syncBillFromPayments` in the purchase routes, and the
 * two must agree on `settleable`: both subtract TDS and the note adjustment
 * before comparing against what has been paid.
 */
export async function syncBillAdjustments(
  tx: Prisma.TransactionClient,
  billId: string
): Promise<void> {
  const bill = await tx.purchaseInvoice.findUnique({
    where: { id: billId },
    select: { id: true, totalAmount: true, tdsAmount: true, status: true },
  })
  if (!bill) return

  const posted = await tx.purchaseNote.findMany({
    where: { billId, status: 'POSTED' },
    select: { effect: true, totalAmount: true },
  })

  // Positive reduces what is owed, which is the ordinary case. A supplier who
  // undercharged and raised a debit note on us pushes the other way.
  const noteAdjustment = round2(
    posted.reduce(
      (s, n) => s + (n.effect === 'REDUCES_PAYABLE' ? 1 : -1) * Number(n.totalAmount),
      0
    )
  )

  const paid = await tx.supplierPayment.aggregate({
    where: { invoiceId: billId, status: 'POSTED' },
    _sum: { amount: true, tdsAmount: true },
  })
  const paidAmount = round2(Number(paid._sum.amount ?? 0))
  const withheldAmount = round2(Number(paid._sum.tdsAmount ?? 0))

  const settleable = round2(Number(bill.totalAmount) - Number(bill.tdsAmount) - noteAdjustment)
  const balanceAmount = round2(Math.max(0, settleable - paidAmount - withheldAmount))

  const status =
    bill.status === 'CANCELLED'
      ? 'CANCELLED'
      : balanceAmount <= 0
        ? 'PAID'
        : paidAmount > 0 || withheldAmount > 0
          ? 'PARTIAL'
          : 'UNPAID'

  await tx.purchaseInvoice.update({
    where: { id: billId },
    data: { noteAdjustment, balanceAmount, status },
  })
}

/**
 * Takes the goods off the rack, or puts them back.
 *
 * Only for the reasons where material actually moved, and only when the note
 * names the godown it moved out of — a note with no warehouse is a paper
 * adjustment, which is the honest reading of a short delivery or a rate
 * correction. The form asks for the godown precisely so that this is a
 * decision somebody took rather than one inferred from a dropdown.
 *
 * `RETURN` rather than `PURCHASE`, so the stock ledger reads as what happened.
 */
export async function moveNoteStock(
  tx: Prisma.TransactionClient,
  note: {
    id: string
    noteNumber: string
    reason: PurchaseNoteReason
    warehouseId: string | null
    noteDate: Date
    lines: Array<{
      itemId: string
      qty: Prisma.Decimal | number
      unitPrice: Prisma.Decimal | number
    }>
  },
  direction: 'OUT' | 'IN'
): Promise<number> {
  if (!note.warehouseId || !REASON_RULES[note.reason].movesGoods) return 0

  let moved = 0
  for (const line of note.lines) {
    const qty = round3(Number(line.qty))
    if (qty <= 0) continue
    await recordMovement(tx, {
      itemId: line.itemId,
      warehouseId: note.warehouseId,
      direction,
      transactionType: 'RETURN',
      referenceType: 'PurchaseNote',
      referenceId: note.id,
      qty,
      // Stock going back in is valued at the note's own rate; stock leaving is
      // valued at what it is carried at, which `recordMovement` decides.
      ...(direction === 'IN' ? { unitRate: round2(Number(line.unitPrice)) } : {}),
      transactionDate: note.noteDate,
      notes:
        direction === 'OUT'
          ? `Returned on ${note.noteNumber}`
          : `${note.noteNumber} cancelled — goods back on the rack`,
    })
    moved += 1
  }
  return moved
}

// ── Guards ──────────────────────────────────────────────────────────────────

/** What may be done to a note in each state, said once. */
export const TRANSITIONS: Record<string, { next: string[]; editable: boolean }> = {
  DRAFT: { next: ['SUBMITTED', 'CANCELLED'], editable: true },
  SUBMITTED: { next: ['APPROVED', 'REJECTED', 'CANCELLED'], editable: false },
  APPROVED: { next: ['POSTED', 'CANCELLED'], editable: false },
  POSTED: { next: ['CANCELLED'], editable: false },
  REJECTED: { next: ['DRAFT'], editable: false },
  CANCELLED: { next: [], editable: false },
}

export function assertEditable(status: string, noteNumber: string): void {
  if (!TRANSITIONS[status]?.editable) {
    throw new AppError(
      `${noteNumber} is ${status.toLowerCase()} and can no longer be edited. Cancel it and raise a fresh note if it is wrong.`,
      409,
      'NOT_EDITABLE'
    )
  }
}
