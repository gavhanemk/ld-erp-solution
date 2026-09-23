import { z } from 'zod'

/**
 * What the server will accept for a debit or credit note against a supplier.
 *
 * The rules that need the database — how much of a bill is left to adjust, who
 * approved what — live in `purchaseNote.service.ts`. What is here is the shape
 * and the arithmetic that can be checked without asking anything: a quantity
 * that is not a number, a note with no lines, a reason of OTHER with nothing
 * written against it.
 */

const NOTE_TYPES = ['DEBIT', 'CREDIT'] as const
const EFFECTS = ['REDUCES_PAYABLE', 'INCREASES_PAYABLE'] as const
const STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REJECTED', 'CANCELLED'] as const
const REASONS = [
  'PURCHASE_RETURN',
  'SHORT_QUANTITY',
  'DAMAGED_MATERIAL',
  'QUALITY_REJECTION',
  'WRONG_MATERIAL',
  'EXCESS_QUANTITY_BILLED',
  'RATE_DIFFERENCE',
  'EXCESS_BILLING',
  'POST_PURCHASE_DISCOUNT',
  'OTHER',
] as const

/** A date sent as `2026-09-23` or as a full ISO stamp, read as local midnight. */
const dateish = z.union([z.string(), z.date()]).transform((v, ctx) => {
  const d = v instanceof Date ? v : new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v)
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'That is not a date' })
    return z.NEVER
  }
  return d
})

const trimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullish()

const noteLineSchema = z.object({
  itemId: z.string().min(1, 'Pick the item this line is for'),
  /** The bill line being adjusted. Absent only on a note with no bill behind it. */
  billLineId: z.string().min(1).nullish(),
  description: trimmed(500),
  hsnCode: trimmed(20),
  originalQty: z.number().nonnegative().nullish(),
  originalRate: z.number().nonnegative().nullish(),
  qty: z
    .number()
    .positive('A line has to be for more than nothing')
    // Three decimals is what the column holds; a fourth would be silently
    // rounded and the total would then disagree with the lines.
    .max(9_999_999, 'That quantity is too large'),
  unitPrice: z.number().nonnegative('A rate cannot be negative').max(99_999_999),
  gstRate: z.number().min(0).max(100, 'A GST rate above 100% is not a rate'),
  remarks: trimmed(500),
})

const noteFields = z
  .object({
    noteType: z.enum(NOTE_TYPES),
    reason: z.enum(REASONS),
    reasonNote: trimmed(500),
    effect: z.enum(EFFECTS),

    /**
     * Only read when there is no bill. With one, the supplier is taken from
     * the bill — a note whose supplier disagrees with the document it adjusts
     * reduces the wrong party's payable.
     */
    supplierId: z.string().min(1, 'Pick the supplier'),
    billId: z.string().min(1).nullish(),
    withoutBillReason: trimmed(500),
    poId: z.string().min(1).nullish(),
    grnId: z.string().min(1).nullish(),

    noteDate: dateish,
    supplierDocNo: trimmed(50),
    supplierDocDate: dateish.nullish(),

    warehouseId: z.string().min(1).nullish(),
    lrNumber: trimmed(50),
    vehicleNo: trimmed(30),
    otherRef: trimmed(100),

    otherCharges: z.number().min(0).max(99_999_999).default(0),
    discountAmount: z.number().min(0).max(99_999_999).default(0),
    notes: trimmed(2000),

    lines: z.array(noteLineSchema).min(1, 'A note needs at least one line'),
  })
  .superRefine((v, ctx) => {
    if (v.reason === 'OTHER' && !v.reasonNote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasonNote'],
        message: 'Say what happened — "Other" on its own tells the next reader nothing',
      })
    }

    // An adjustment with no invoice behind it is allowed, but it is a decision
    // somebody takes rather than a field they forgot. Without this a mistyped
    // bill id silently becomes an unlinked note that no balance check covers.
    if (!v.billId && !v.withoutBillReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['billId'],
        message: 'Link the supplier bill this adjusts, or say why there is none to link',
      })
    }

    // A supplier's own document is what makes a credit note theirs. Recorded
    // without it, nobody can match it to the paper in the file.
    if (v.noteType === 'CREDIT' && !v.supplierDocNo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supplierDocNo'],
        message: "Enter the supplier's credit note number, as printed on their document",
      })
    }

    if (v.billId && v.lines.some((l) => !l.billLineId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message:
          'Every line has to point at a line of the bill. Pick the lines from the bill rather than typing them.',
      })
    }

    if (v.supplierDocDate && v.supplierDocDate > v.noteDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supplierDocDate'],
        message: "The supplier's document cannot be dated after the note that records it",
      })
    }
  })

export const createNoteSchema = noteFields
export const updateNoteSchema = noteFields

export const noteListQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  noteType: z.enum(NOTE_TYPES).optional(),
  status: z.enum(STATUSES).optional(),
  reason: z.enum(REASONS).optional(),
  supplierId: z.string().min(1).optional(),
  billId: z.string().min(1).optional(),
  warehouseId: z.string().min(1).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export type CreateNoteInput = z.infer<typeof createNoteSchema>
export type NoteListQuery = z.infer<typeof noteListQuerySchema>
