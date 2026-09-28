import type { Prisma } from '@prisma/client'
import type {
  PurchaseAdjustmentDoc,
  PurchaseAdjustmentIssuer,
  PurchaseNoteReason,
  PurchaseNoteStatus,
} from '@prisma/client'
import type { ReportColumn, ReportFilter, ReportParams, Tone } from '../types'
import { dayRange } from './shared'

/**
 * What every report about purchase adjustments shares.
 *
 * ── Why these maps are typed against the Prisma enum ────────────────────────
 *
 * `Record<PurchaseNoteStatus, string>` makes TypeScript insist on every member
 * and refuse any that is not one. That is not decoration: the last time a
 * status map in this repository was written by hand it drifted — it carried
 * RECEIVED and CLOSED, which the schema has never had, and lacked COMPLETED,
 * which it does. Three things failed quietly at once, and the only reason it
 * was found was somebody reading the file. Written this way, adding a status
 * to the schema breaks the build until every report has a word for it.
 */

export const NOTE_STATUS_WORDS: Record<PurchaseNoteStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Awaiting approval',
  APPROVED: 'Approved',
  POSTED: 'Posted',
  REJECTED: 'Sent back',
  CANCELLED: 'Cancelled',
}

/**
 * What each state means, which decides its colour.
 *
 * `SUBMITTED` is amber rather than blue on purpose. On screen it is a state; on
 * a report it is a queue — somebody is waiting on somebody else, and the whole
 * point of the sheet is to show who.
 */
export const NOTE_STATUS_TONES: Record<PurchaseNoteStatus, Tone> = {
  DRAFT: 'neutral',
  SUBMITTED: 'warn',
  APPROVED: 'info',
  POSTED: 'good',
  REJECTED: 'bad',
  CANCELLED: 'neutral',
}

export const NOTE_REASON_WORDS: Record<PurchaseNoteReason, string> = {
  PURCHASE_RETURN: 'Material returned',
  SHORT_QUANTITY: 'Short quantity',
  DAMAGED_MATERIAL: 'Damaged material',
  QUALITY_REJECTION: 'Quality rejection',
  WRONG_MATERIAL: 'Wrong material',
  WRONG_RATE: 'Wrong rate charged',
  EXCESS_BILLING: 'Excess billing',
  POST_PURCHASE_DISCOUNT: 'Discount after the bill',
  OTHER: 'Something else',
}

/**
 * Which reasons are the supplier's fault rather than the paperwork's.
 *
 * A return, a rejection, damage and wrong material are failures of what was
 * delivered. A rate difference or an over-billing is a failure of what was
 * typed. Both cost money and only the first says anything about whether to
 * keep buying from somebody, so the reports separate them.
 */
export const GOODS_FAILURE_REASONS: PurchaseNoteReason[] = [
  'PURCHASE_RETURN',
  'DAMAGED_MATERIAL',
  'QUALITY_REJECTION',
  'WRONG_MATERIAL',
  'SHORT_QUANTITY',
]

/**
 * What kind of document each row is.
 *
 * Four, not two. "Debit note" and "credit note" were a pair only while every
 * adjustment was assumed to come off the bill — a supplier's debit note is
 * also a debit note and moves the money the other way, and a register that
 * calls both of them "Debit note" is a register that cannot be totalled.
 */
export const NOTE_TYPE_WORDS: Record<PurchaseAdjustmentDoc, string> = {
  OUR_DEBIT_NOTE: 'Our claim',
  SUPPLIER_CREDIT_NOTE: 'Their credit note',
  SUPPLIER_DEBIT_NOTE: 'Their debit note',
  OTHER: 'Other adjustment',
}

export const ISSUER_WORDS: Record<PurchaseAdjustmentIssuer, string> = {
  OUR_COMPANY: 'Us',
  SUPPLIER: 'Supplier',
}

/** The statuses that still stand. A cancelled or refused note claims nothing. */
export const STANDING: PurchaseNoteStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED']

// ── Filters ─────────────────────────────────────────────────────────────────

export const reasonFilter: ReportFilter = {
  key: 'reason',
  label: 'What happened',
  type: 'select',
  options: (Object.keys(NOTE_REASON_WORDS) as PurchaseNoteReason[]).map((value) => ({
    value,
    label: NOTE_REASON_WORDS[value],
  })),
}

export const noteTypeFilter: ReportFilter = {
  key: 'type',
  label: 'Document',
  type: 'select',
  options: (Object.keys(NOTE_TYPE_WORDS) as PurchaseAdjustmentDoc[]).map((value) => ({
    value,
    label: NOTE_TYPE_WORDS[value],
  })),
}

export const noteStatusFilter: ReportFilter = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: (Object.keys(NOTE_STATUS_WORDS) as PurchaseNoteStatus[]).map((value) => ({
    value,
    label: NOTE_STATUS_WORDS[value],
  })),
}

export const locationFilter: ReportFilter = {
  key: 'warehouseId',
  label: 'Godown',
  type: 'select',
  optionsFrom: 'warehouses',
  help: 'Only notes whose goods left a particular godown',
}

/**
 * The "Amount" filter the old system had, as bands rather than a free number.
 *
 * A typed figure needs a comparison beside it — over, under, between — and
 * three controls to answer one question nobody asks precisely. Bands answer
 * the question that is actually asked: show me the ones worth looking at.
 */
export const SIZE_BANDS: Record<string, number> = {
  '10000': 10_000,
  '50000': 50_000,
  '100000': 100_000,
}

export const sizeFilter: ReportFilter = {
  key: 'minAmount',
  label: 'Worth at least',
  type: 'select',
  options: [
    { value: '10000', label: '₹10,000' },
    { value: '50000', label: '₹50,000' },
    { value: '100000', label: '₹1,00,000' },
  ],
  help: 'Hides the small ones',
}

export const postedOnlyFilter: ReportFilter = {
  key: 'postedOnly',
  label: 'Posted only',
  type: 'boolean',
  help: 'Only notes that have actually come off a bill',
}

// ── The query every note report runs ────────────────────────────────────────

/**
 * The where clause, built once.
 *
 * Every report here filters the same way, and a clause written out five times
 * is a clause that means five slightly different things by the second change.
 * Cancelled and refused notes are excluded unless a status is asked for
 * explicitly: they claim nothing, and a register whose total includes them is
 * a register whose total is wrong.
 */
export function noteWhere(
  params: ReportParams,
  docType?: PurchaseAdjustmentDoc
): Prisma.PurchaseNoteWhereInput {
  const range = dayRange(params)
  const min = params.minAmount ? SIZE_BANDS[params.minAmount] : undefined

  return {
    ...(docType ? { docType } : {}),
    ...(params.status
      ? { status: params.status as PurchaseNoteStatus }
      : params.postedOnly === 'true'
        ? { status: 'POSTED' as const }
        : { status: { in: STANDING } }),
    ...(params.reason ? { reason: params.reason as PurchaseNoteReason } : {}),
    ...(params.supplierId ? { supplierId: params.supplierId } : {}),
    ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
    ...(range ? { noteDate: range } : {}),
    ...(min !== undefined ? { totalAmount: { gte: min } } : {}),
    ...(params.itemId ? { lines: { some: { itemId: params.itemId } } } : {}),
    ...(params.q
      ? {
          OR: [
            { noteNumber: { contains: params.q, mode: 'insensitive' as const } },
            { supplierDocNo: { contains: params.q, mode: 'insensitive' as const } },
            { reasonNote: { contains: params.q, mode: 'insensitive' as const } },
            { supplier: { name: { contains: params.q, mode: 'insensitive' as const } } },
            { bill: { billNumber: { contains: params.q, mode: 'insensitive' as const } } },
            { bill: { supplierInvoiceNo: { contains: params.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  }
}

/** Everything the note reports read off a note. Selected once, for the same reason. */
export const noteSelect = {
  id: true,
  noteNumber: true,
  docType: true,
  issuedBy: true,
  gstTreatment: true,
  status: true,
  reason: true,
  reasonNote: true,
  effect: true,
  noteDate: true,
  supplierDocNo: true,
  supplierDocDate: true,
  taxableAmount: true,
  cgst: true,
  sgst: true,
  igst: true,
  otherCharges: true,
  discountAmount: true,
  totalAmount: true,
  postedAt: true,
  createdAt: true,
  supplier: { select: { id: true, code: true, name: true } },
  bill: {
    select: {
      id: true,
      billNumber: true,
      supplierInvoiceNo: true,
      billDate: true,
      totalAmount: true,
    },
  },
  warehouse: { select: { name: true } },
  createdBy: { select: { name: true } },
  approvedBy: { select: { name: true } },
  _count: { select: { lines: true } },
} satisfies Prisma.PurchaseNoteSelect

export type NoteRow = Prisma.PurchaseNoteGetPayload<{ select: typeof noteSelect }>

/** The status column, with its words and its colours, written once. */
export const statusColumn: ReportColumn = {
  key: 'status',
  label: 'Status',
  type: 'badge',
  width: 17,
  badges: NOTE_STATUS_WORDS,
  badgeTones: NOTE_STATUS_TONES,
}

/**
 * The document column, for a register that carries every kind at once.
 *
 * The tones separate the two that reduce the bill from the one that increases
 * it, because that is the distinction a reader of this column is actually
 * making and the four names on their own do not make it obvious.
 */
export const typeColumn: ReportColumn = {
  key: 'type',
  label: 'Document',
  type: 'badge',
  width: 16,
  badges: NOTE_TYPE_WORDS,
  badgeTones: {
    OUR_DEBIT_NOTE: 'info',
    SUPPLIER_CREDIT_NOTE: 'normal',
    SUPPLIER_DEBIT_NOTE: 'warn',
    OTHER: 'normal',
  },
}

/**
 * How long a note has been waiting, in days, or null if it is not waiting.
 *
 * Only DRAFT, SUBMITTED and APPROVED are waiting on anybody. A posted note has
 * arrived and a cancelled one is not going anywhere, and counting either as
 * "22 days old" turns the oldest-waiting figure into a number about history.
 */
export function waitingDays(n: {
  status: PurchaseNoteStatus
  noteDate: Date
  createdAt: Date
}): number | null {
  if (n.status === 'POSTED' || n.status === 'CANCELLED' || n.status === 'REJECTED') return null
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const from = n.createdAt > n.noteDate ? n.createdAt : n.noteDate
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  return Math.max(0, Math.floor((start.getTime() - day.getTime()) / 86_400_000))
}

/** Tax on a note — the three components added, since a report prints one figure. */
export function taxOf(n: {
  cgst: Prisma.Decimal
  sgst: Prisma.Decimal
  igst: Prisma.Decimal
}): number {
  return Math.round((Number(n.cgst) + Number(n.sgst) + Number(n.igst)) * 100) / 100
}

/**
 * What a note does to the payable, signed.
 *
 * Positive reduces what is owed. Taken from `effect` rather than from the
 * document type, because the two genuinely come apart — a supplier who
 * undercharged raises a debit note ON us, and reading the sign off the word
 * "debit" would move that money the wrong way.
 */
export function signedEffect(n: { effect: string; totalAmount: Prisma.Decimal }): number {
  const sign = n.effect === 'REDUCES_PAYABLE' ? 1 : -1
  return Math.round(sign * Number(n.totalAmount) * 100) / 100
}
