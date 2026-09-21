import { z } from 'zod'

/**
 * What the purchase bill screens are allowed to send.
 *
 * A purchase bill is the supplier's tax invoice, booked into our books. Two
 * numbers matter and they are not the same: `supplierInvoiceNo` is theirs and
 * appears on the paper, `billNumber` is ours and is allocated by the number
 * series. The person entering it only ever types the supplier's.
 *
 * Wording is aimed at an accounts clerk holding the bill, not at a developer.
 */

const qty = z
  .number({ invalid_type_error: 'Quantity has to be a number' })
  .positive('Quantity must be more than zero')
  .max(9_999_999, 'That quantity looks like a typo')

const rate = z
  .number({ invalid_type_error: 'Rate has to be a number' })
  .min(0, 'A rate cannot be negative')
  .max(9_999_999, 'That rate looks like a typo')

const money = z
  .number({ invalid_type_error: 'That has to be an amount' })
  .min(0, 'An amount cannot be negative')
  .max(99_999_999, 'That amount looks like a typo')

const percent = (what: string) =>
  z
    .number({ invalid_type_error: `${what} has to be a number` })
    .min(0, `${what} cannot be negative`)
    .max(100, `${what} cannot be more than 100%`)

// The message has to be set three times over. `.min()` only speaks when the
// value arrived as a string and was empty; a field left off the request
// entirely is an invalid_type, and its default wording is "Required", which
// tells a clerk nothing about which box to go back to.
const id = (what: string) =>
  z
    .string({ required_error: `Pick ${what}`, invalid_type_error: `Pick ${what}` })
    .min(1, `Pick ${what}`)

export const billLineSchema = z.object({
  itemId: id('an item'),
  /**
   * The receipt line this bill line settles. Optional because a bill for
   * something that never had a receipt — a transporter's bill, a service — is
   * legitimate. When it is present, the handler checks the billed quantity
   * against what was actually accepted.
   */
  grnLineId: z.string().optional().nullable(),
  description: z.string().max(300).optional().nullable(),
  qty,
  unitPrice: rate,
  discount: percent('Discount').optional(),
  gstRate: percent('GST rate').optional(),
  /**
   * What to do when the supplier has billed a different rate than the order
   * agreed. Required only on a line where the two actually differ — an
   * ordinary line never carries it.
   *
   * `ACCEPT` books the supplier's rate, and the bill needs a reason saying
   * why it was agreed. `DEBIT_NOTE` books the order's rate and raises a draft
   * debit note to the supplier for the difference.
   */
  rateAction: z.enum(['ACCEPT', 'DEBIT_NOTE']).optional().nullable(),
})

/**
 * Freight, transport, dyeing — the extras the supplier adds at the foot of the
 * bill. Each carries its own GST rate, which is why they cannot simply be
 * added to the goods value.
 */
export const billChargeSchema = z.object({
  chargeTypeId: id('a charge'),
  amount: money,
  gstRate: percent('GST rate').optional(),
})

const billBase = z.object({
  supplierId: id('a supplier'),
  poId: z.string().optional().nullable(),
  /*
   * The number and date printed on the supplier's own invoice.
   *
   * Both required. A bill is only ever booked once their invoice is on the
   * desk — that is the document being entered, and this is its identity.
   * They were optional while nobody had said otherwise, which let a bill be
   * saved with no way to tie it back to the supplier's paper.
   *
   * It is also what makes the duplicate guard bite. The unique index on
   * (supplier, invoice number) cannot catch a second booking of the same
   * invoice while the number is allowed to be blank, because Postgres treats
   * every NULL as distinct from every other.
   */
  supplierInvoiceNo: z
    .string({ required_error: "Put the supplier's bill number in" })
    .trim()
    .min(1, "Put the supplier's bill number in")
    .max(50, 'That bill number is too long'),
  // An error map rather than required_error: `coerce.date` turns a missing
  // value into an Invalid Date before the required check ever runs, so it
  // fails as "Invalid date" — which tells a clerk nothing about which box.
  supplierInvoiceDate: z.coerce.date({
    errorMap: () => ({ message: 'Put the date on the supplier’s bill' }),
  }),
  billDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional().nullable(),
  discountAmount: money.optional(),
  /**
   * GST we owe the government directly rather than paying it to the supplier.
   * Common on transport and on bills from unregistered parties. When it is set
   * the tax is still worked out and recorded, but it is not added to what the
   * supplier is paid.
   */
  isReverseCharge: z.boolean().optional(),
  tdsSection: z.string().max(20).optional().nullable(),
  tdsRate: percent('TDS rate').optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  /**
   * Why a rate higher than the order was agreed to. Asked for once per bill
   * rather than per line, because a supplier who raised their price raised it
   * for one reason and typing it four times helps nobody.
   */
  rateVarianceReason: z.string().max(300).optional().nullable(),
  lines: z.array(billLineSchema).min(1, 'A bill needs at least one line'),
  charges: z.array(billChargeSchema).optional(),
})

export const createBillSchema = billBase.superRefine((data, ctx) => {
  // A bill dated before the supplier's own invoice would be booking a document
  // that did not exist yet, and it puts the two in different GST periods.
  if (data.supplierInvoiceDate && data.billDate && data.supplierInvoiceDate > data.billDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['supplierInvoiceDate'],
      message: 'The supplier’s invoice date cannot be after the date you are booking it',
    })
  }

  if (data.dueDate && data.billDate && data.dueDate < data.billDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dueDate'],
      message: 'The due date cannot be before the bill date',
    })
  }

  if (data.tdsRate && !data.tdsSection) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tdsSection'],
      message: 'Say which TDS section this is deducted under, or clear the rate',
    })
  }
})

// `.superRefine()` leaves a ZodEffects, which has no `.partial()`. The base
// object is kept separate for exactly this reason — see the build rules.
export const updateBillSchema = billBase.partial()

export type BillLineInput = z.infer<typeof billLineSchema>
export type BillChargeInput = z.infer<typeof billChargeSchema>
