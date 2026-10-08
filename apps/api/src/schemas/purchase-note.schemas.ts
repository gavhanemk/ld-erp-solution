import { z } from 'zod'

/**
 * What the server will accept for an adjustment against a supplier's bill.
 *
 * The rules that need the database — how much of a bill is left to adjust, who
 * approved what — live in `purchaseNote.service.ts`. What is here is the shape
 * and the arithmetic that can be checked without asking anything: a quantity
 * that is not a number, a note with no lines, a reason of OTHER with nothing
 * written against it.
 *
 * Three lists where there used to be one. `noteType` was DEBIT|CREDIT and was
 * answering "who issued it", "what document is it" and "which way does the
 * money go" all at once, so it could express two of the eight combinations
 * that occur. They are separate here for the same reason they are separate in
 * the database: a supplier's debit note is theirs, is a debit note, and
 * INCREASES what we owe, and no single flag says all three.
 */

/** Who raised it. */
const ISSUERS = ['OUR_COMPANY', 'SUPPLIER'] as const
/** What kind of document it is. */
const DOC_TYPES = [
  'OUR_DEBIT_NOTE',
  'SUPPLIER_CREDIT_NOTE',
  'SUPPLIER_DEBIT_NOTE',
  'OTHER',
] as const
/** Which way it moves the payable. Sent only for OTHER; derived otherwise. */
const EFFECTS = ['REDUCES_PAYABLE', 'INCREASES_PAYABLE'] as const
const STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REJECTED', 'CANCELLED'] as const
/** What happened. An event, carrying no direction and no document. */
const REASONS = [
  'PURCHASE_RETURN',
  'SHORT_QUANTITY',
  'DAMAGED_MATERIAL',
  'QUALITY_REJECTION',
  'WRONG_MATERIAL',
  'WRONG_RATE',
  'EXCESS_BILLING',
  'POST_PURCHASE_DISCOUNT',
  'OTHER',
] as const
/** The accounts desk's classification. Never accepted on create or update. */
const GST_TREATMENTS = [
  'NOT_REVIEWED',
  'GST_CREDIT_NOTE',
  'GST_DEBIT_NOTE',
  'ITC_REVERSAL_ONLY',
  'NO_GST_IMPACT',
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
  /**
   * The receipt line being adjusted, on a note with no bill behind it — set
   * when the line was pulled from a GRN's rejected quantity rather than
   * typed by hand.
   */
  grnLineId: z.string().min(1).nullish(),
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
    /* What happened, who issued it, and what kind of document it is: asked
       separately because they are separately known. `effect` is derived from
       `docType` on the server and is only read for OTHER, whose direction is
       a decision rather than a definition. */
    reason: z.enum(REASONS),
    reasonNote: trimmed(500),
    issuedBy: z.enum(ISSUERS),
    docType: z.enum(DOC_TYPES),
    effect: z.enum(EFFECTS).nullish(),

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

    /* How the note goes in the GST return, picked on the note beside the GST
       it carries. Optional on a draft; the post route refuses a note without
       one, so GST is settled here, before anything touches the bill. */
    gstTreatment: z.enum(GST_TREATMENTS).optional(),

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

    // A supplier's own document is what makes the adjustment theirs. Recorded
    // without it, nobody can match it to the paper in the file — and at GST
    // time it is their number the department matches against, not ours.
    if (
      (v.docType === 'SUPPLIER_CREDIT_NOTE' || v.docType === 'SUPPLIER_DEBIT_NOTE') &&
      !v.supplierDocNo
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supplierDocNo'],
        message: "Enter the supplier's document number, as printed on their note",
      })
    }

    // A "supplier credit note" raised by us is not a supplier credit note.
    // Checked here as well as on the server so the form can say so before a
    // round trip, and checked on the server because this one is about money.
    if (v.docType === 'SUPPLIER_CREDIT_NOTE' || v.docType === 'SUPPLIER_DEBIT_NOTE') {
      if (v.issuedBy !== 'SUPPLIER') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['issuedBy'],
          message: 'That document comes from the supplier. Change the type, or who issued it.',
        })
      }
    } else if (v.docType === 'OUR_DEBIT_NOTE' && v.issuedBy !== 'OUR_COMPANY') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issuedBy'],
        message: 'Our own debit note is issued by us. Change the type, or who issued it.',
      })
    }

    // OTHER is the one kind whose direction nothing defines, so it has to be
    // said. Silently defaulting it to "reduces" is how an increase becomes a
    // reduction with nobody having decided anything.
    if (v.docType === 'OTHER' && !v.effect) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effect'],
        message: 'Say whether this reduces or increases what the supplier is owed',
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
  /* One kind, or several separated by commas.
     The Debit Notes screen asks for our claims AND the supplier's debit notes
     in one request, because they are both debit notes and belong on one
     screen. A single-valued filter would have forced two round trips and two
     sets of totals that then had to be added up by hand. */
  docType: z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.enum(DOC_TYPES)).min(1))
    .optional(),
  issuedBy: z.enum(ISSUERS).optional(),
  effect: z.enum(EFFECTS).optional(),
  gstTreatment: z.enum(GST_TREATMENTS).optional(),
  /* One status, or several separated by commas — the same shape as `docType`
     above, and for the same reason. The cards over the list stand for sets
     rather than single states: "Still to post" is every state a note can be
     posted out of, and there are four of those left over from the approval
     workflow. Pressing that card has to narrow the list to exactly the notes
     it counted, which a single-valued filter cannot express. */
  status: z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.enum(STATUSES)).min(1))
    .optional(),
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

/**
 * What the accounts desk may set, and the only place it may be set from.
 *
 * Its own schema rather than a field on the note, because it is its own
 * decision by its own people: the purchase office records what happened in
 * the godown and never touches this.
 */
export const gstTreatmentSchema = z.object({
  gstTreatment: z.enum(GST_TREATMENTS).refine((v) => v !== 'NOT_REVIEWED', {
    message: 'Pick how this is to be treated for GST',
  }),
  gstNote: trimmed(1000),
})

export type CreateNoteInput = z.infer<typeof createNoteSchema>
export type NoteListQuery = z.infer<typeof noteListQuerySchema>
export type GstTreatmentInput = z.infer<typeof gstTreatmentSchema>
