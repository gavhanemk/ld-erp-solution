import { z } from 'zod'

/**
 * What the return challan screen is allowed to send.
 *
 * The person filling this in is at the loading bay with the goods on a
 * vehicle, so every message says what to do rather than what is wrong with
 * the payload.
 */

/**
 * The reasons a challan can carry — only the ones where material physically
 * leaves. A rate difference or a discount after the bill moves nothing, and
 * goes on a debit note raised directly against the bill instead.
 */
export const RETURN_REASONS = [
  'PURCHASE_RETURN',
  'DAMAGED_MATERIAL',
  'QUALITY_REJECTION',
  'WRONG_MATERIAL',
] as const

const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, `That ${what} is too long`)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null))

const lineSchema = z.object({
  billLineId: z.string().min(1, 'Every line has to say which bill line it is going back against'),
  warehouseId: z.string().min(1, 'Pick the godown the goods are leaving from'),
  qty: z
    .number({ invalid_type_error: 'The quantity going back has to be a number' })
    .positive('The quantity going back has to be more than zero')
    .max(9_999_999, 'That quantity looks like a typo'),
  remarks: text(300, 'line remark'),
})

export const createReturnSchema = z
  .object({
    billId: z.string().min(1, 'Pick the bill these goods are going back against'),
    returnDate: z.coerce.date().optional(),
    reason: z.enum(RETURN_REASONS, {
      errorMap: () => ({ message: 'Say why the goods are going back' }),
    }),
    reasonNote: text(500, 'reason'),
    vehicleNo: text(20, 'vehicle number'),
    transporterName: text(120, 'transporter name'),
    lrNumber: text(40, 'LR number'),
    ewayBillNo: text(20, 'e-way bill number'),
    driverName: text(80, 'driver name'),
    remarks: text(1000, 'remark'),
    lines: z.array(lineSchema).min(1, 'Enter what is going back on at least one line'),
  })
  .superRefine((data, ctx) => {
    /*
     * One bill line may appear more than once — a line received into two
     * godowns goes back from both — but not twice from the same godown, which
     * passes every per-line check and then takes the goods out twice.
     */
    const seen = new Set<string>()
    data.lines.forEach((l, i) => {
      const key = l.billLineId + '::' + l.warehouseId
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'warehouseId'],
          message:
            'This item is already going back from that godown on this challan. Put the whole quantity on one row.',
        })
      }
      seen.add(key)
    })
  })

export const cancelReturnSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Say why this challan is being cancelled — one line is enough')
    .max(500),
})

export const returnListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().optional(),
  status: z.enum(['DISPATCHED', 'CANCELLED']).optional(),
  supplierId: z.string().optional(),
  billId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
})
