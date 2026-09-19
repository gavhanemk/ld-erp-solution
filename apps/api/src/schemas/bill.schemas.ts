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
  /** The number printed on the supplier's own invoice. */
  supplierInvoiceNo: z.string().max(50).optional().nullable(),
  supplierInvoiceDate: z.coerce.date().optional().nullable(),
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
