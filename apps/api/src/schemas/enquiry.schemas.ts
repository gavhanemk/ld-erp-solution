import { z } from 'zod'

/**
 * What can be typed onto a purchase enquiry, and what cannot.
 *
 * The split that matters is between what *we* ask and what *they* answer.
 * Quantities, expected rates, the location and the required date are ours and
 * live on the enquiry schemas. A proforma invoice — its number, its date, its
 * total and the rates on it — belongs to one supplier, and is only ever set
 * through `recordQuoteSchema` against that supplier's own quote. Letting the
 * enquiry form write a quoted rate would mean a rate could appear on the
 * document with no PI behind it, and the whole purpose of the step is that the
 * order's price can be traced to a document a supplier sent.
 */

export const ENQUIRY_STATUSES = ['DRAFT', 'SENT', 'QUOTED', 'ORDERED', 'CLOSED'] as const
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number]

const lineSchema = z.object({
  /*
   * The existing line this row IS, on an edit.
   *
   * Without it every save reads as "delete all seven lines, add seven new
   * ones" — which defeats the guard on what has already been ordered, throws
   * away the rates suppliers quoted against those lines, and cuts any purchase
   * order raised from this enquiry loose from the line it was quoted on.
   * Absent on a line being added, which is how the two are told apart.
   */
  id: z.string().optional(),
  itemId: z.string().min(1, 'Pick an item'),
  description: z.string().max(300).optional().nullable(),
  qty: z.number().positive('Quantity must be more than zero'),
  /*
   * What the mill expects to pay, where the buyer has a view. Optional, and
   * usually empty — an enquiry goes out precisely because nobody knows the
   * rate. Zero is allowed and is not the same as empty: "we expect this free of
   * charge" is a real position to put to a supplier.
   */
  expectedRate: z.number().min(0, 'A rate cannot be negative').optional().nullable(),
  /*
   * The indent line this answers, where the buyer took it off the indent list
   * rather than typing it. Not checked against the item, for the same reason
   * the order does not check it: enquiring about a substitute is ordinary, and
   * refusing it would send the buyer back to typing the line by hand, which
   * loses the link to the job entirely.
   */
  mrLineId: z.string().optional().nullable(),
})

export const createEnquirySchema = z.object({
  enquiryDate: z.coerce.date().optional(),
  requiredDate: z.coerce.date().optional().nullable(),
  /** Where the goods are wanted. Empty is head office, the old system's "HO". */
  locationId: z.string().optional().nullable(),
  reference: z.string().max(100).optional().nullable(),
  /** Printed on the supplier's copy. */
  notes: z.string().max(2000).optional().nullable(),
  terms: z.string().max(2000).optional().nullable(),
  /** Internal. Never printed. */
  remark: z.string().max(1000).optional().nullable(),
  lines: z.array(lineSchema).min(1, 'An enquiry needs at least one item'),
  /*
   * Who to ask. More than one is the point of the document — the old ERP has a
   * whole stage for comparing what comes back — but one is allowed and is what
   * most enquiries are, and none is allowed too: an enquiry drafted before
   * anybody has decided who to ask is a real state.
   */
  supplierIds: z.array(z.string().min(1)).max(20, 'Twenty suppliers is plenty').optional(),
})

export const updateEnquirySchema = createEnquirySchema
  .omit({ supplierIds: true })
  .partial()
  .extend({
    lines: z.array(lineSchema).min(1, 'An enquiry needs at least one item').optional(),
  })

/** Adding a supplier to an enquiry already raised. */
export const addQuoteSchema = z.object({
  supplierId: z.string().min(1, 'Pick a supplier'),
  placeOfSupplyCode: z
    .string()
    .regex(/^\d{2}$/, 'A GST state code is two digits')
    .optional()
    .nullable(),
  remark: z.string().max(1000).optional().nullable(),
})

/**
 * Recording one supplier's proforma invoice.
 *
 * `amount` is what his PI states, and it is stored as stated rather than
 * recomputed from the rates below. When the two disagree the buyer has to see
 * it before ordering — a mismatch is usually a charge he has added, or an
 * arithmetic slip worth a phone call, and silently replacing his total with
 * ours hides both.
 *
 * Rates are optional per line. A supplier who quotes one lump sum for a mixed
 * enquiry is common, and refusing to record his PI because it does not break
 * down per item would push the whole thing back onto email.
 */
export const recordQuoteSchema = z.object({
  piNumber: z.string().min(1, 'The proforma invoice needs its number').max(50),
  piDate: z.coerce.date(),
  amount: z.number().min(0, 'A total cannot be negative').optional().nullable(),
  /** How long he will hold the price. */
  validUntil: z.coerce.date().optional().nullable(),
  remark: z.string().max(1000).optional().nullable(),
  rates: z
    .array(
      z.object({
        lineId: z.string().min(1),
        quotedRate: z.number().min(0, 'A rate cannot be negative').optional().nullable(),
        gstRate: z.number().min(0).max(100).optional().nullable(),
        /*
         * What he says he can actually supply, where it is less than was asked.
         * A supplier who can only manage 800 of the 1,240 has answered the
         * enquiry, and losing that would lose the reason the buyer split the
         * order between two of them.
         */
        offeredQty: z.number().min(0).optional().nullable(),
        remark: z.string().max(300).optional().nullable(),
      })
    )
    .optional(),
})

/**
 * Passing a supplier over.
 *
 * The reason is kept on the losing quote rather than only read off the winner,
 * because "his rate was 8% higher" and "he never answered" are different things
 * to say to him next time he is asked.
 */
export const declineQuoteSchema = z.object({
  reason: z.string().min(3, 'Say why he was passed over').max(300),
})

/**
 * Dropping the whole enquiry.
 *
 * The reason is required. An enquiry closed with nothing recorded gets raised
 * again three weeks later by somebody who cannot tell whether every rate was
 * too high, nobody answered, or the job was cancelled.
 */
export const closeEnquirySchema = z.object({
  reason: z.string().min(3, 'Say why it is being dropped').max(300),
})

/** A comma-separated list in the query string becomes an array of statuses. */
const statusList = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  )
  .pipe(z.array(z.enum(ENQUIRY_STATUSES)).min(1))

export const enquiryListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(20),
  status: statusList.optional(),
  /** Any enquiry that went to this supplier, whether or not he answered. */
  supplierId: z.string().optional(),
  itemId: z.string().optional(),
  locationId: z.string().optional(),
  /** Inclusive at both ends. */
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().optional(),
  /*
   * Enquiries whose quoted price has run out, which is the one thing about this
   * document that goes stale on its own. A rate held only until the 12th is not
   * a rate on the 13th, and an order raised against it is an argument.
   */
  expired: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** The recycle bin. Everything else passes over deleted rows. */
  deleted: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
})

export type EnquiryLineInput = z.infer<typeof lineSchema>
