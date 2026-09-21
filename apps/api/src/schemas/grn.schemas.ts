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

/** A reference number off somebody else's paperwork. */
const ref = (what: string, max = 60) =>
  z.string().max(max, `That ${what} is too long`).optional().nullable()

const lineSchema = z.object({
  poLineId: z.string().min(1, 'Every line has to say which order line it is against'),
  warehouseId: z.string().min(1, 'Pick the store the goods went into'),
  receivedQty: qty,
  rejectedQty: qty.optional(),
  batchNumber: z.string().max(50).optional().nullable(),
})

/**
 * The fields a receipt's own paperwork and lines are made of — shared between
 * raising a new receipt and editing one already on the books, so the two
 * cannot drift into accepting different shapes of the same document.
 *
 * `receivedQty` is what came off the vehicle and `rejectedQty` is how much of
 * that was refused. What is actually taken into stock is the difference, worked
 * out here rather than typed: a store keeper counting rolls on a loading bay
 * should not also be doing subtraction, and the two figures disagreeing is the
 * commonest way a goods receipt goes wrong.
 */
const grnFields = {
  grnDate: z.coerce.date().optional(),
  vehicleNo: z.string().max(20, 'That vehicle number is too long').optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),

  /*
   * The delivery itself.
   *
   * Every one of these is optional, and that is the point: the person typing
   * is at the gate with a lorry waiting, and a receipt refused because the
   * driver's name was blank would put the stock figure behind the goods.
   * They are worth capturing because they are what settles a query about the
   * supplier's bill months later, when nobody remembers the delivery.
   */
  gateEntryNo: ref('gate entry number', 40),
  gateEntryDate: z.coerce.date().optional().nullable(),
  challanNo: ref('challan number'),
  challanDate: z.coerce.date().optional().nullable(),
  supplierBillNo: ref('bill number'),
  supplierInvoiceNo: ref('invoice number'),
  supplierInvoiceDate: z.coerce.date().optional().nullable(),
  packageCount: z
    .number({ invalid_type_error: 'The number of packages has to be a number' })
    .int('Packages are counted in whole numbers')
    .min(0, 'A package count cannot be negative')
    .max(100000, 'That package count looks like a typo')
    .optional()
    .nullable(),
  driverName: ref('driver name', 80),
  formNo: ref('form number'),
  clientName: ref('client name', 120),
  orderedBy: ref('name', 80),
  referenceNo: ref('reference'),

  /*
   * Which of the supplier's addresses this delivery's paperwork names.
   *
   * Defaults to the order's own address when left out — most deliveries
   * come from wherever the order was placed with. Set only when this
   * challan or invoice names a different branch of the supplier than the
   * order was raised against.
   */
  supplierAddressId: z.string().optional().nullable(),

  /*
   * Which of the mill's own stores the lorry actually arrived at.
   *
   * Defaults to the order's own delivery warehouse when left out. Set only
   * when the driver turned up somewhere else than the order named — a
   * different gate needs no correction to every line's own store, which is
   * what actually decides where the stock is counted.
   */
  shippingWarehouseId: z.string().optional().nullable(),

  /*
   * Why this receipt books in more than the order's own balance.
   *
   * Left out on an ordinary receipt. Required only when some line's excess
   * runs past the mill's configured tolerance — checked and enforced
   * server-side, not here, because that check needs the order and the
   * tolerance setting, neither of which this schema can see.
   */
  overReceiptReason: z.string().max(500).optional().nullable(),

  lines: z.array(lineSchema).min(1, 'Add at least one line'),
}

/** Every rule that depends on more than one field at once, shared the same way. */
function refineGrnFields(data: { lines: z.infer<typeof lineSchema>[] }, ctx: z.RefinementCtx) {
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

    /*
     * One order line may appear more than once, but only for different
     * stores.
     *
     * A single delivery of 800kg routinely goes 500 to the fabric godown and
     * 300 to the works, and the mill's old system had a row per location for
     * exactly that. What is still refused is the same item into the same
     * store twice, which passes every per-line check and then books the
     * goods in twice.
     */
    const key = `${line.poLineId}::${line.warehouseId}`
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines', i, 'warehouseId'],
        message:
          'This item is already going into that store on this receipt. Put the whole quantity on one row, or pick another store.',
      })
    }
    seen.add(key)
  })

  if (!data.lines.some((l) => l.receivedQty > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lines'],
      message: 'Nothing was received. Enter what arrived on at least one line.',
    })
  }
}

export const createGrnSchema = z
  .object({
    poId: z.string().min(1, 'Pick the purchase order these goods came against'),
    ...grnFields,
  })
  .superRefine(refineGrnFields)

/**
 * Correcting a receipt already on the books — quantities included.
 *
 * The order this receipt is against does not change here; raising it against
 * a different order is a different receipt. Everything else — which lines,
 * how much, which store, the paperwork — can be corrected in one go rather
 * than by cancelling and re-typing the whole thing.
 *
 * The reason is required for the same reason cancelling one asks for one:
 * changing a document that has already moved stock is exactly the kind of
 * thing a stock audit asks about six months later, and "why" has to be
 * answered by the document itself, not by whoever remembers that week.
 */
export const updateGrnSchema = z
  .object({
    ...grnFields,
    editReason: z
      .string()
      .min(5, 'Say why this receipt is being corrected — one line is enough')
      .max(500),
  })
  .superRefine(refineGrnFields)

/**
 * Undoing a receipt.
 *
 * The reason is required because a cancelled receipt with no explanation is
 * the first thing questioned in a stock audit.
 */
export const cancelGrnSchema = z.object({
  reason: z.string().min(5, 'Say why the receipt is being cancelled — one line is enough').max(500),
})

/**
 * Deleting a receipt outright, rather than cancelling it.
 *
 * Cancelling is the ordinary undo — it reverses the stock and keeps the
 * document, which is what a stock audit wants to find. Deleting removes the
 * row entirely, and is meant for the receipts that should not exist at all —
 * a duplicate, a test, a wrong order picked by mistake — not for a real
 * delivery that turned out to be wrong, which cancelling already covers.
 * Unlike cancelling and correcting, no reason is required: the audit log
 * already keeps the whole deleted document, and this is meant to be quick.
 */
export const deleteGrnSchema = z.object({
  reason: z.string().max(500).optional(),
})
