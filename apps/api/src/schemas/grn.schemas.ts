import { z } from 'zod'

/**
 * What the goods receipt screen is allowed to send.
 *
 * The person filling this in is standing at the gate with a delivery challan in
 * one hand, so every message has to say what to do rather than what is wrong
 * with the payload.
 */

const qty = z
  .number({ invalid_type_error: 'Quantity has to be a number' })
  .min(0, 'A quantity cannot be negative')
  .max(9_999_999, 'That quantity looks like a typo')

/**
 * Receiving against an order.
 *
 * `receivedQty` is what came off the vehicle and `rejectedQty` is how much of
 * that was refused. What is actually taken into stock is the difference, worked
 * out here rather than typed: a store keeper counting rolls on a loading bay
 * should not also be doing subtraction, and the two figures disagreeing is the
 * commonest way a goods receipt goes wrong.
 */
export const createGrnSchema = z
  .object({
    poId: z.string().min(1, 'Pick the purchase order these goods came against'),
    grnDate: z.coerce.date().optional(),
    vehicleNo: z.string().max(20, 'That vehicle number is too long').optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
    lines: z
      .array(
        z.object({
          poLineId: z.string().min(1, 'Every line has to say which order line it is against'),
          warehouseId: z.string().min(1, 'Pick the store the goods went into'),
          receivedQty: qty,
          rejectedQty: qty.optional(),
          batchNumber: z.string().max(50).optional().nullable(),
        })
      )
      .min(1, 'Add at least one line'),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>()

    data.lines.forEach((line, i) => {
      const rejected = line.rejectedQty ?? 0

      if (rejected > line.receivedQty) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'rejectedQty'],
          message: `You cannot reject ${rejected} out of the ${line.receivedQty} that arrived.`,
        })
      }

      // The same order line twice in one receipt would pass every per-line
      // check and then quietly book the goods in twice.
      if (seen.has(line.poLineId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'poLineId'],
          message: 'This item is already on the receipt. Put the whole quantity on one line.',
        })
      }
      seen.add(line.poLineId)
    })

    if (!data.lines.some((l) => l.receivedQty > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'Nothing was received. Enter what arrived on at least one line.',
      })
    }
  })

/**
 * Undoing a receipt.
 *
 * A receipt cannot be edited once the stock has moved, so a mistake is
 * cancelled and re-entered. The reason is required because a cancelled receipt
 * with no explanation is the first thing questioned in a stock audit.
 */
export const cancelGrnSchema = z.object({
  reason: z.string().min(5, 'Say why the receipt is being cancelled — one line is enough').max(500),
})
