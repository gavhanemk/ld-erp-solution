import type { Prisma } from '@prisma/client'
import type {
  PurchaseAdjustmentDoc,
  PurchaseAdjustmentIssuer,
  PurchaseGstTreatment,
  PurchaseNoteEffect,
  PurchaseNoteReason,
} from '@prisma/client'
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

// ── The three questions, answered separately ──────────────────────────────

/**
 * What happened — and nothing else.
 *
 * A buyer is asked what they saw: cloth came back, a roll never arrived, the
 * rate on the bill is not the rate that was agreed. They are not asked what
 * document that becomes, who should issue it, or what GST makes of it. Those
 * are three further questions with three different people answering them, and
 * this table deliberately answers none of them.
 *
 * It used to. Every entry carried `type: 'DEBIT'` and `effect:
 * 'REDUCES_PAYABLE'`, which made the reason decide the direction of the money
 * — so "material damaged" could only ever come *off* the bill. A supplier who
 * answers damaged goods by shipping replacements and billing for them is a
 * perfectly ordinary event, and the old table could not record it at all.
 *
 * What survives here is only what the event itself genuinely settles: whether
 * goods physically move, and whether the claim eats into the billed quantity.
 */
export const REASON_RULES: Record<
  PurchaseNoteReason,
  {
    /** What the purchase office would call it. */
    label: string
    /** One line under the option, in the words of the thing that happened. */
    hint: string
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
    /**
     * The document this *usually* turns out to be, offered as a starting
     * point on the form and changeable on every one of them.
     *
     * A suggestion, not a rule. It exists so a clerk recording the ordinary
     * case does not have to think, and it is labelled as a suggestion on
     * screen so the unusual case is not waved through as the ordinary one.
     */
    commonly: PurchaseAdjustmentDoc
  }
> = {
  PURCHASE_RETURN: {
    label: 'Material returned',
    hint: 'Goods went back to the supplier',
    movesGoods: true,
    consumesQty: true,
    commonly: 'OUR_DEBIT_NOTE',
  },
  SHORT_QUANTITY: {
    label: 'Short quantity received',
    hint: 'Billed for more than actually arrived',
    movesGoods: false,
    consumesQty: true,
    commonly: 'OUR_DEBIT_NOTE',
  },
  DAMAGED_MATERIAL: {
    label: 'Material damaged',
    hint: 'Arrived damaged and cannot be used',
    movesGoods: true,
    consumesQty: true,
    commonly: 'OUR_DEBIT_NOTE',
  },
  QUALITY_REJECTION: {
    label: 'Rejected on quality',
    hint: 'Failed inspection — shade, GSM, finish',
    movesGoods: true,
    consumesQty: true,
    commonly: 'OUR_DEBIT_NOTE',
  },
  WRONG_MATERIAL: {
    label: 'Wrong material sent',
    hint: 'Not what was ordered',
    movesGoods: true,
    consumesQty: true,
    commonly: 'OUR_DEBIT_NOTE',
  },
  WRONG_RATE: {
    label: 'Wrong rate charged',
    hint: 'The bill is not at the rate that was agreed',
    movesGoods: false,
    consumesQty: false,
    commonly: 'OUR_DEBIT_NOTE',
  },
  EXCESS_BILLING: {
    label: 'Excess billing',
    hint: 'Charged for something not supplied',
    movesGoods: false,
    consumesQty: false,
    commonly: 'OUR_DEBIT_NOTE',
  },
  POST_PURCHASE_DISCOUNT: {
    label: 'Discount after the bill',
    hint: 'The supplier agreed a reduction afterwards',
    movesGoods: false,
    consumesQty: false,
    commonly: 'SUPPLIER_CREDIT_NOTE',
  },
  OTHER: {
    label: 'Something else',
    hint: 'Say what happened in your own words',
    movesGoods: false,
    consumesQty: false,
    commonly: 'OUR_DEBIT_NOTE',
  },
}

/**
 * What kind of document it is — and therefore which way the money moves.
 *
 * This is the table that decides the direction, and it is keyed on the
 * document rather than on the event, because the document is the only thing
 * that carries a direction. The same damaged lot reduces the bill when we
 * claim for it, reduces it again if the supplier credits it, and *increases*
 * it if the supplier's answer is a debit note for replacements. The event did
 * not change. The document did.
 */
export const DOC_RULES: Record<
  PurchaseAdjustmentDoc,
  {
    label: string
    hint: string
    /** Who this kind of document comes from, by definition. */
    issuedBy: PurchaseAdjustmentIssuer
    /**
     * Which way it moves the payable. `null` for OTHER, which is the one kind
     * whose direction is a decision rather than a definition — so the form
     * asks, rather than this table guessing.
     */
    effect: PurchaseNoteEffect | null
    /** Their number and their date are what make a document theirs. */
    needsSupplierDoc: boolean
    /** The numbering series it draws from. */
    series: string
  }
> = {
  OUR_DEBIT_NOTE: {
    label: 'Our debit note / claim',
    hint: 'We are claiming money back. A commercial claim, not by itself a GST document.',
    issuedBy: 'OUR_COMPANY',
    effect: 'REDUCES_PAYABLE',
    needsSupplierDoc: false,
    series: 'DN',
  },
  SUPPLIER_CREDIT_NOTE: {
    label: "Supplier's credit note",
    hint: 'They sent a document reducing their own invoice. We are recording it.',
    issuedBy: 'SUPPLIER',
    effect: 'REDUCES_PAYABLE',
    needsSupplierDoc: true,
    series: 'SCN',
  },
  SUPPLIER_DEBIT_NOTE: {
    label: "Supplier's debit note",
    hint: 'They sent a document increasing their own invoice. We will owe MORE, not less.',
    issuedBy: 'SUPPLIER',
    effect: 'INCREASES_PAYABLE',
    needsSupplierDoc: true,
    series: 'SDN',
  },
  OTHER: {
    label: 'Other adjustment',
    hint: 'As configured by Accounts. Whoever raises it says which way it moves.',
    issuedBy: 'OUR_COMPANY',
    effect: null,
    needsSupplierDoc: false,
    series: 'PADJ',
  },
}

/**
 * The direction, settled once.
 *
 * Either the document type defines it, or — for OTHER alone — somebody said
 * so explicitly. There is no third path where a direction gets inferred from
 * a document's name.
 */
export function effectFor(
  docType: PurchaseAdjustmentDoc,
  chosen?: PurchaseNoteEffect | null
): PurchaseNoteEffect {
  const fixed = DOC_RULES[docType].effect
  if (fixed) return fixed
  if (!chosen) {
    throw new AppError(
      'Say whether this adjustment reduces or increases what the supplier is owed',
      400,
      'EFFECT_REQUIRED'
    )
  }
  return chosen
}

/**
 * Whether a document and an issuer can both be true at once.
 *
 * A "supplier credit note" raised by our company is not a supplier credit
 * note. Left unchecked this is exactly the sort of mismatch that reads fine on
 * screen and then makes the GST return disagree with the file.
 */
export function assertIssuerMatches(
  docType: PurchaseAdjustmentDoc,
  issuedBy: PurchaseAdjustmentIssuer
): void {
  // OTHER is the configured case and may legitimately come from either side.
  if (docType === 'OTHER') return
  const expected = DOC_RULES[docType].issuedBy
  if (issuedBy !== expected) {
    throw new AppError(
      `${DOC_RULES[docType].label} is issued by ${
        expected === 'SUPPLIER' ? 'the supplier' : 'us'
      }. Either change the document type or change who issued it.`,
      400,
      'ISSUER_MISMATCH'
    )
  }
}

/**
 * How the accounts desk may classify an adjustment, in their own words.
 *
 * Nothing in the purchase office writes this. A clerk records that twelve
 * rolls came back damaged; whether that becomes a section 34 credit note, an
 * input-credit reversal, or a purely commercial claim with no GST consequence
 * depends on the supplier's filing and on whether they ever issued a document
 * — none of which a buyer can know.
 */
export const GST_TREATMENTS: Record<PurchaseGstTreatment, { label: string; hint: string }> = {
  NOT_REVIEWED: {
    label: 'Not reviewed yet',
    hint: 'Accounts has not classified this. It cannot be posted while it says this.',
  },
  GST_CREDIT_NOTE: {
    label: 'GST credit note — s.34(1)',
    hint: 'Supplier issued a credit note. Our input credit reduces.',
  },
  GST_DEBIT_NOTE: {
    label: 'GST debit note — s.34(3)',
    hint: 'Supplier issued a debit note. Further input credit is available.',
  },
  ITC_REVERSAL_ONLY: {
    label: 'Input credit reversal only',
    hint: 'No supplier document. We reverse the credit ourselves.',
  },
  NO_GST_IMPACT: {
    label: 'No GST effect',
    hint: 'Commercial only. The invoice and the input credit both stand.',
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
  /**
   * The net of every note still standing against this line: reductions less
   * increases. Negative means the line is worth more than the bill charged,
   * because a supplier debit note added to it.
   */
  adjustedQty: number
  adjustedValue: number
  /** What is left to reduce. Never below zero. */
  remainingQty: number
  remainingValue: number
  /**
   * The receipt this line was billed from, and what was rejected on it — so
   * the "raise a note for the rejected qty" shortcut can find, on the bill it
   * now has, the same line it used to only find on the receipt, and suggest
   * the same quantity it always did.
   */
  grnId: string | null
  rejectedQty: number
  /** What the receipt actually recorded for this line, alongside the rejection —
   *  so a note being raised for the rejected part can be shown next to what was
   *  received and accepted, not just the billed quantity. */
  receivedQty: number
  acceptedQty: number
  /** The godown the receipt itself named — every GRN line has one, whether
   *  what it carries was accepted or rejected — so a note that moves goods
   *  can default to where they actually are instead of asking again. */
  warehouseId: string | null
}

/**
 * Line by line, what a bill has left to give.
 *
 * Two ceilings, not one, because they answer different questions. Quantity
 * stops a hundred metres being returned twice. Value stops a line being
 * claimed back for more than it was ever charged — which quantity alone does
 * not, since a return at an invented rate passes a quantity check comfortably.
 *
 * Reducing notes consume the balance; increasing ones give it back, so the
 * figures here are the *net* of everything still standing against the line.
 * The bill itself is never touched — `billedQty` and `billedTaxable` are read
 * straight off the invoice however many notes have accumulated against it.
 *
 * Every status in `LIVE_STATUSES` counts, drafts included. Two drafts each
 * claiming the whole line, both later approved, is exactly the duplicate the
 * accounts desk catches by hand today, and the cheap moment to catch it is
 * while the second one is being typed.
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
          // So a note raised straight off the receipt, before this bill
          // existed, can be found below and counted against the same line —
          // and so the rejected quantity that receipt line carries can be
          // read straight off the bill line too.
          grnLineId: true,
          grnLine: {
            select: {
              grnId: true,
              rejectedQty: true,
              receivedQty: true,
              acceptedQty: true,
              warehouseId: true,
            },
          },
          item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
        },
      },
    },
  })
  if (!bill) throw new AppError('That purchase bill no longer exists', 404, 'NOT_FOUND')

  const grnLineIds = bill.lines.map((l) => l.grnLineId).filter((id): id is string => Boolean(id))

  const liveNote = {
    status: { in: [...LIVE_STATUSES] },
    ...(excludeNoteId ? { id: { not: excludeNoteId } } : {}),
  }

  const [billClaims, grnClaims] = await Promise.all([
    tx.purchaseNoteLine.findMany({
      where: { billLineId: { in: bill.lines.map((l) => l.id) }, note: liveNote },
      select: {
        billLineId: true,
        qty: true,
        taxableValue: true,
        note: { select: { reason: true, effect: true } },
      },
    }),
    /*
     * The other door onto this same rejection.
     *
     * A rejection can be noted straight off the receipt before any bill
     * exists — `adjustableOnGrn`, offered on the goods receipt screen for
     * exactly that gap between goods arriving and accounts booking the
     * bill. That note sits on `grnLineId`, not this bill's `billLineId`, so
     * without this second query the same rejected quantity reads as fully
     * available here too and can be claimed a second time once the bill
     * turns up.
     */
    grnLineIds.length > 0
      ? tx.purchaseNoteLine.findMany({
          where: { grnLineId: { in: grnLineIds }, note: liveNote },
          select: {
            grnLineId: true,
            qty: true,
            taxableValue: true,
            note: { select: { reason: true, effect: true } },
          },
        })
      : Promise.resolve([]),
  ])

  /*
   * Signed, because not every adjustment comes off the bill.
   *
   * A supplier's debit note adds to what the invoice is worth. Counting it as
   * consumed headroom — which an unsigned sum does — would block a later
   * genuine claim against the very material they had just charged more for,
   * and the message would read "already adjusted" about an adjustment that
   * went the other way.
   */
  const byLine = new Map<string, { qty: number; value: number }>()
  const applyClaim = (
    key: string,
    c: {
      qty: unknown
      taxableValue: unknown
      note: { reason: PurchaseNoteReason; effect: PurchaseNoteEffect }
    }
  ) => {
    const at = byLine.get(key) ?? { qty: 0, value: 0 }
    const sign = c.note.effect === 'REDUCES_PAYABLE' ? 1 : -1
    // Only a claim on the goods eats the quantity; a rate correction does not.
    if (REASON_RULES[c.note.reason].consumesQty) at.qty += sign * Number(c.qty)
    at.value += sign * Number(c.taxableValue)
    byLine.set(key, at)
  }

  for (const c of billClaims) {
    if (c.billLineId) applyClaim(c.billLineId, c)
  }

  const billLineByGrnLine = new Map(
    bill.lines
      .filter((l): l is typeof l & { grnLineId: string } => Boolean(l.grnLineId))
      .map((l) => [l.grnLineId, l.id])
  )
  for (const c of grnClaims) {
    const billLineId = c.grnLineId ? billLineByGrnLine.get(c.grnLineId) : undefined
    if (billLineId) applyClaim(billLineId, c)
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
      grnId: l.grnLine?.grnId ?? null,
      rejectedQty: round3(Number(l.grnLine?.rejectedQty ?? 0)),
      receivedQty: round3(Number(l.grnLine?.receivedQty ?? 0)),
      acceptedQty: round3(Number(l.grnLine?.acceptedQty ?? 0)),
      warehouseId: l.grnLine?.warehouseId ?? null,
    }
  })
}

/**
 * What a receipt still has left to note, line by line — for the note raised
 * with no bill behind it.
 *
 * Goods rejected at the gate are refused before they are ever counted as
 * received: `GRNLine.rejectedQty` is exactly the part of a delivery that
 * `acceptedQty` already excludes, so it is never billed and there is no bill
 * line for a note to point at. This is the same shape as `adjustableOn` —
 * what came off the receipt, less what every other live note already claims
 * against it — read from `grnLineId` instead of `billLineId`.
 *
 * Only lines with something rejected are worth a receipt keeper's time, but
 * every line is returned regardless; the caller filters, the same way the
 * bill picker does.
 */
export interface AdjustableGrnLine {
  grnLineId: string
  itemId: string
  itemCode: string
  itemName: string
  uom: string | null
  hsnCode: string | null
  gstRate: number
  /** What was rejected on this receipt line — never billed, and so the whole of what there is to note. */
  rejectedQty: number
  rejectedRate: number
  /** What the receipt recorded alongside the rejection, so it can be shown next to it. */
  receivedQty: number
  acceptedQty: number
  /** Already claimed by other live notes against this same receipt line. */
  notedQty: number
  /** What is still left to note. Never below zero. */
  remainingQty: number
  /** The godown the receipt itself named — every GRN line has one. */
  warehouseId: string
}

export async function adjustableOnGrn(
  tx: Prisma.TransactionClient,
  grnId: string,
  excludeNoteId?: string
): Promise<{ lines: AdjustableGrnLine[]; poId: string | null; supplierId: string }> {
  const grn = await tx.gRN.findUnique({
    where: { id: grnId },
    select: {
      id: true,
      po: { select: { id: true, supplierId: true } },
      lines: {
        select: {
          id: true,
          itemId: true,
          rejectedQty: true,
          receivedQty: true,
          acceptedQty: true,
          unitRate: true,
          warehouseId: true,
          poLine: { select: { gstRate: true } },
          item: {
            select: {
              code: true,
              name: true,
              hsnCode: true,
              uom: { select: { symbol: true } },
              taxRate: { select: { rate: true } },
            },
          },
        },
      },
    },
  })
  if (!grn) throw new AppError('That goods receipt no longer exists', 404, 'NOT_FOUND')
  if (!grn.po)
    throw new AppError(
      'The order this receipt was raised against no longer exists',
      404,
      'NOT_FOUND'
    )

  const claims = await tx.purchaseNoteLine.findMany({
    where: {
      grnLineId: { in: grn.lines.map((l) => l.id) },
      note: {
        status: { in: [...LIVE_STATUSES] },
        ...(excludeNoteId ? { id: { not: excludeNoteId } } : {}),
      },
    },
    select: { grnLineId: true, qty: true },
  })

  const notedByLine = new Map<string, number>()
  for (const c of claims) {
    if (!c.grnLineId) continue
    notedByLine.set(c.grnLineId, (notedByLine.get(c.grnLineId) ?? 0) + Number(c.qty))
  }

  const lines = grn.lines.map((l) => {
    const rejectedQty = round3(Number(l.rejectedQty))
    const noted = round3(notedByLine.get(l.id) ?? 0)
    return {
      grnLineId: l.id,
      itemId: l.itemId,
      itemCode: l.item.code,
      itemName: l.item.name,
      uom: l.item.uom?.symbol ?? null,
      hsnCode: l.item.hsnCode,
      gstRate: Number(l.poLine?.gstRate ?? l.item.taxRate?.rate ?? 0),
      rejectedQty,
      rejectedRate: Number(l.unitRate),
      receivedQty: round3(Number(l.receivedQty)),
      acceptedQty: round3(Number(l.acceptedQty)),
      notedQty: noted,
      remainingQty: round3(Math.max(0, rejectedQty - noted)),
      warehouseId: l.warehouseId,
    }
  })

  return { lines, poId: grn.po.id, supplierId: grn.po.supplierId }
}

/**
 * How much of each receipt line already has a live note against it,
 * straight off the line — not through a bill.
 *
 * The one fact both `/bills/match/:grnId` and a bill's own detail need, so a
 * rejection already noted before any bill existed does not read as still
 * needing one just because the screen only knows to look at `rejectedQty`.
 */
export async function notedQtyByGrnLine(
  tx: Prisma.TransactionClient,
  grnLineIds: string[]
): Promise<Map<string, number>> {
  if (!grnLineIds.length) return new Map()
  const rows = await tx.purchaseNoteLine.groupBy({
    by: ['grnLineId'],
    where: { grnLineId: { in: grnLineIds }, note: { status: { in: [...LIVE_STATUSES] } } },
    _sum: { qty: true },
  })
  return new Map(
    rows
      .filter((r): r is typeof r & { grnLineId: string } => Boolean(r.grnLineId))
      .map((r) => [r.grnLineId, Number(r._sum.qty ?? 0)])
  )
}

// ── Pricing ─────────────────────────────────────────────────────────────────

export interface NoteLineInput {
  itemId: string
  billLineId?: string | null
  grnLineId?: string | null
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
 * Which way the goods go follows the money, not the caller. A note that
 * reduces the bill is material leaving — returned or written off. A note that
 * increases it is material arriving: the supplier shipped replacements and
 * billed for them. Passing the direction in by hand is how those two ended up
 * both booked as OUT.
 *
 * `RETURN` rather than `PURCHASE`, so the stock ledger reads as what happened.
 */
export async function moveNoteStock(
  tx: Prisma.TransactionClient,
  note: {
    id: string
    noteNumber: string
    reason: PurchaseNoteReason
    effect: PurchaseNoteEffect
    warehouseId: string | null
    noteDate: Date
    /** The return challan the note was raised from, if any. */
    returnId?: string | null
    lines: Array<{
      itemId: string
      qty: Prisma.Decimal | number
      unitPrice: Prisma.Decimal | number
    }>
  },
  /** POST moves the goods the way the note says; REVERSE puts them back. */
  mode: 'POST' | 'REVERSE'
): Promise<number> {
  /*
   * A note raised from a return challan is the money side of goods that have
   * already gone. The challan took them off the rack at the gate; moving them
   * again here would take the same rolls out twice. Checked on the link, not
   * on the warehouse being empty, because the note form lets somebody fill in
   * a godown and the rule must not depend on them leaving it blank.
   */
  if (note.returnId) return 0
  if (!note.warehouseId || !REASON_RULES[note.reason].movesGoods) return 0

  const natural = note.effect === 'REDUCES_PAYABLE' ? 'OUT' : 'IN'
  const direction: 'OUT' | 'IN' = mode === 'POST' ? natural : natural === 'OUT' ? 'IN' : 'OUT'

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
        mode === 'POST'
          ? direction === 'OUT'
            ? `Returned on ${note.noteNumber}`
            : `Received against ${note.noteNumber}`
          : `${note.noteNumber} cancelled — stock put back`,
    })
    moved += 1
  }
  return moved
}

// ── Guards ──────────────────────────────────────────────────────────────────

/**
 * What may be done to a note in each state, said once.
 *
 * Two live states and one way out: a note is written, then it is posted, and a
 * posted note can be cancelled. The submit-and-approve round trip in between
 * was removed — it queued every adjustment behind a second person for a
 * decision that `purchase:post` already gates, and the queue was the only
 * thing it reliably produced.
 *
 * SUBMITTED, APPROVED and REJECTED are kept, postable and editable, purely so
 * that rows written before the change can still be finished. Nothing puts a
 * note into them any more.
 */
export const TRANSITIONS: Record<string, { next: string[]; editable: boolean }> = {
  DRAFT: { next: ['POSTED', 'CANCELLED'], editable: true },
  POSTED: { next: ['CANCELLED'], editable: false },
  CANCELLED: { next: [], editable: false },

  // Left over from the approval workflow. No new note reaches these.
  SUBMITTED: { next: ['POSTED', 'CANCELLED'], editable: true },
  APPROVED: { next: ['POSTED', 'CANCELLED'], editable: true },
  REJECTED: { next: ['POSTED', 'CANCELLED'], editable: true },
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

/**
 * The state a supplier is in for tax, read once and frozen onto the note.
 *
 * Copied from the bill where there is one, because an adjustment has to carry
 * the same split as the document it corrects — a CGST bill credited with IGST
 * leaves a difference on the GST return that nobody can clear.
 */
export async function taxContextFor(
  tx: Prisma.TransactionClient,
  supplierId: string,
  billId: string | null | undefined
): Promise<boolean> {
  if (billId) {
    const bill = await tx.purchaseInvoice.findUnique({
      where: { id: billId },
      select: { igst: true, cgst: true, sgst: true },
    })
    if (bill && (Number(bill.igst) > 0 || Number(bill.cgst) > 0 || Number(bill.sgst) > 0)) {
      return Number(bill.igst) <= 0
    }
  }

  const [company, supplier] = await Promise.all([
    tx.company.findFirst({ select: { stateCode: true, gstin: true } }),
    tx.supplier.findUnique({ where: { id: supplierId }, select: { stateCode: true, gstin: true } }),
  ])
  const ours = company?.stateCode || company?.gstin?.slice(0, 2)
  const theirs = supplier?.stateCode || supplier?.gstin?.slice(0, 2)
  // An unregistered supplier carries no split to make, and a note against them
  // carries no tax either. Treated as intra-state so nothing lands in IGST.
  return !theirs || !ours || theirs === ours
}
