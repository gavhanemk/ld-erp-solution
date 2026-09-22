import { z } from 'zod'

/**
 * What the supplier payment screen is allowed to send.
 *
 * A payment settles one bill. A mill paying four bills with one cheque
 * records four payments against the same cheque number, which is how the
 * accounts team already works on paper — the cheque is the reference, the
 * bill is the thing being settled. Splitting one payment across bills would
 * need a join table and buys nothing until somebody asks for it.
 *
 * Wording is aimed at whoever is holding the cheque book, not at a developer.
 */

const money = z
  .number({ invalid_type_error: 'That has to be an amount' })
  .positive('A payment has to be more than zero')
  .max(99_999_999, 'That amount looks like a typo')

const id = (what: string) =>
  z
    .string({ required_error: `Pick ${what}`, invalid_type_error: `Pick ${what}` })
    .min(1, `Pick ${what}`)

/**
 * How the money left. `PDC` is a post-dated cheque — handed over now, banked
 * later, and the mill uses them enough that lumping them in with ordinary
 * cheques would lose the distinction that matters.
 */
export const paymentModes = ['CASH', 'CHEQUE', 'NEFT', 'RTGS', 'UPI', 'PDC'] as const

/** The modes where a bare amount is not enough to find the money again. */
const NEEDS_REFERENCE = new Set(['CHEQUE', 'PDC', 'NEFT', 'RTGS', 'UPI'])

/** The modes that are a cheque, and so carry a date the cheque itself bears. */
const IS_CHEQUE = new Set(['CHEQUE', 'PDC'])

const paymentBase = z.object({
  billId: id('a bill to pay'),
  paymentDate: z.coerce.date().optional(),
  amount: money,
  mode: z.enum(paymentModes, {
    required_error: 'Say how it was paid',
    invalid_type_error: 'Say how it was paid',
  }),
  /** Cheque number, UTR, or the UPI reference — whatever finds it at the bank. */
  referenceNo: z.string().max(60).optional().nullable(),
  chequeDate: z.coerce.date().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
})

export const createPaymentSchema = paymentBase.superRefine((data, ctx) => {
  // A payment dated in the future has not happened. Somebody has usually typed
  // next year by accident, and it would sit in the wrong GST period.
  if (data.paymentDate && data.paymentDate > new Date()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['paymentDate'],
      message: 'A payment cannot be dated in the future',
    })
  }

  if (NEEDS_REFERENCE.has(data.mode) && !data.referenceNo?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['referenceNo'],
      message:
        data.mode === 'CHEQUE' || data.mode === 'PDC'
          ? 'Put the cheque number in'
          : 'Put the transaction reference in',
    })
  }

  // A post-dated cheque without its date is the one case where the date is the
  // whole point of the record — it is what says when the money actually goes.
  if (IS_CHEQUE.has(data.mode) && !data.chequeDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['chequeDate'],
      message: 'Put the date written on the cheque',
    })
  }

  if (!IS_CHEQUE.has(data.mode) && data.chequeDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['chequeDate'],
      message: 'A cheque date only belongs on a cheque',
    })
  }
})

export type CreatePaymentInput = z.infer<typeof paymentBase>
