import { z } from 'zod'

const qty = z
  .number({ invalid_type_error: 'Quantity has to be a number' })
  .min(0, 'A quantity cannot be negative')
  .max(9_999_999, 'That quantity looks like a typo')

/**
 * One line of a check. Only what was rejected is sent — what passed is the
 * rest of what the line received, worked out on the server, so the two can
 * never add up to anything but the delivery.
 */
const lineSchema = z.object({
  grnLineId: z.string().min(1),
  rejectedQty: qty,
  reason: z.string().max(300).optional().nullable(),
})

export const createQcSchema = z
  .object({
    grnId: z.string().min(1, 'Pick the receipt being checked'),
    inspectionDate: z.coerce.date().optional(),
    rejectWarehouseId: z.string().optional().nullable(),
    remarks: z.string().max(1000).optional().nullable(),
    lines: z.array(lineSchema).min(1, 'A check needs at least one line'),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>()
    data.lines.forEach((l, i) => {
      if (seen.has(l.grnLineId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'grnLineId'],
          message: 'The same receipt line is on this check twice',
        })
      }
      seen.add(l.grnLineId)
      if (l.rejectedQty > 0 && (l.reason?.trim().length ?? 0) < 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'reason'],
          message: 'Say why it was rejected',
        })
      }
    })
    // A reject godown is optional. The mill keeps one store, so a check is
    // normally recorded without moving anything; see the QC route.
  })

export const cancelQcSchema = z.object({
  reason: z
    .string({ required_error: 'Say why the check is being cancelled' })
    .trim()
    .min(5, 'Say why the check is being cancelled — one line is enough')
    .max(500),
})
