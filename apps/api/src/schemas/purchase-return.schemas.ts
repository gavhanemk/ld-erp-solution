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
  /**
   * Why this row is going back. Every row says its own; a caller that still
   * sends one reason for the whole challan has it stand for rows without one.
   */
  reason: z.enum(RETURN_REASONS).optional(),
  /**
   * The mill's own name for the reason, when it is one from Masters →
   * Dropdown Lists. `reason` is then the built-in one it works like.
   */
  reasonLabel: z.string().trim().max(60).optional().nullable(),
})

export const createReturnSchema = z
  .object({
    billId: z.string().min(1, 'Pick the bill these goods are going back against'),
    returnDate: z.coerce.date().optional(),
    /*
     * The challan's own reason. Optional now that each row carries one — the
     * server works out the main reason from the rows. Still accepted, and
     * used for any row that does not say, so an older screen keeps working.
     */
    reason: z
      .enum(RETURN_REASONS, {
        errorMap: () => ({ message: 'Say why the goods are going back' }),
      })
      .optional(),
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
     * One bill line may appear more than once — from two godowns, or for two
     * reasons (30 damaged, 20 off-shade) — but not twice with the same godown
     * and the same reason. That pair says nothing two rows can say that one
     * cannot, and is nearly always the same quantity typed in twice.
     */
    const seen = new Set<string>()
    data.lines.forEach((l, i) => {
      if (!l.reason && !data.reason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'reason'],
          message: 'Say why each row is going back',
        })
      }
      const key =
        l.billLineId + '::' + l.warehouseId + '::' + (l.reasonLabel || (l.reason ?? data.reason))
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'reason'],
          message:
            'This item is already going back from that godown for the same reason on this challan. Pick a different reason for this row, or put the quantity on one row.',
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
