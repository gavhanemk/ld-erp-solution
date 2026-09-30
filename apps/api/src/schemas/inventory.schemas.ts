import { z } from 'zod'

/**
 * What the stock screens are allowed to send.
 *
 * The wording of every message is aimed at a store keeper, not a developer.
 * "Expected number, received string" tells the person holding the fabric roll
 * nothing they can act on.
 */

const qty = z
  .number({ invalid_type_error: 'Quantity has to be a number' })
  .positive('Quantity must be more than zero')
  .max(9_999_999, 'That quantity looks like a typo')

const rate = z
  .number({ invalid_type_error: 'Rate has to be a number' })
  .min(0, 'A rate cannot be negative')
  .max(9_999_999, 'That rate looks like a typo')

/**
 * The rate stock comes in at, where nothing on hand can price it.
 *
 * More than nought. Opening stock left without a rate used to be saved at ₹0
 * with no word said, and every metre of it then counted for nothing in the
 * stock value and dragged down the average everything after it left at.
 */
const inRate = z
  .number({
    required_error: 'Enter a rate: what one unit cost',
    invalid_type_error: 'Rate has to be a number',
  })
  .positive('Enter a rate: at ₹0 this stock would be valued at nothing')
  .max(9_999_999, 'That rate looks like a typo')

const id = (what: string) => z.string().min(1, `Pick ${what}`)

/**
 * Opening stock — what was on hand the day the mill started using this system.
 *
 * It needs a rate because an opening balance with no value would put the whole
 * stock valuation out from day one, and nothing later can recover it.
 */
export const openingStockSchema = z.object({
  warehouseId: id('a warehouse'),
  asOnDate: z.coerce.date().optional(),
  notes: z.string().max(1000).optional().nullable(),
  lines: z
    .array(
      z.object({
        itemId: id('an item'),
        qty,
        unitRate: inRate,
        batchNumber: z.string().max(50).optional().nullable(),
      }),
    )
    .min(1, 'Add at least one item'),
})

/**
 * What the store can answer, and what has to be bought.
 *
 * A separate call from creating the requisition, and deliberately so. The mill's
 * old ERP asks this question on the store's own screen — *Approved Material
 * Requisition*, with Issue Raw Material and Create Indent side by side — after
 * the requisition has been approved, and it is right to ask it there. The person
 * raising a requisition is asking for material; they do not know what is on the
 * rack. The store keeper does, and their form shows the stock beside every line
 * while they decide.
 *
 * Asking it on the requisition form instead, as this once did, puts the answer
 * in the hands of the only person in the building who cannot know it.
 */
/**
 * The store's plan for an approved requisition: how much of each line to buy.
 *
 * Any amount from nothing upward — part of what is short, all of it, the whole
 * line, or more than was asked with the extra going into stock. What is
 * handed over from the racks is the issue, a separate step.
 */
export const requisitionPlanSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: id('a line'),
        buyQty: z
          .number({ invalid_type_error: 'The quantity to buy has to be a number' })
          .min(0, 'The quantity to buy cannot be negative')
          .max(9_999_999),
      }),
    )
    .min(1, 'Nothing to change'),
})

export const requisitionSourcingSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: id('a line'),
        fulfilment: z.enum(['FROM_STOCK', 'PURCHASE']),
      }),
    )
    .min(1, 'Nothing to change'),
})

/**
 * A correction after a physical count.
 *
 * `countedQty` rather than a plus-or-minus figure: the store keeper counts what
 * is on the rack and types that. Working out the difference is the computer's
 * job, and a person doing it in their head is a person who sometimes gets the
 * sign the wrong way round.
 */
export const adjustmentSchema = z.object({
  warehouseId: id('a warehouse'),
  adjustmentDate: z.coerce.date().optional(),
  reason: z
    .string()
    .min(5, 'Say why the figure is being changed — one line is enough')
    .max(500),
  lines: z
    .array(
      z.object({
        itemId: id('an item'),
        countedQty: z
          .number({ invalid_type_error: 'Counted quantity has to be a number' })
          .min(0, 'A counted quantity cannot be negative')
          .max(9_999_999, 'That quantity looks like a typo'),
        /** Only used when the count is higher and there is nothing on hand to price it from. */
        unitRate: inRate.optional(),
      }),
    )
    .min(1, 'Add at least one item'),
})

export const transferSchema = z.object({
  fromWarehouseId: id('the store it leaves'),
  toWarehouseId: id('the store it goes to'),
  transferDate: z.coerce.date().optional(),
  notes: z.string().max(1000).optional().nullable(),
  lines: z
    .array(z.object({ itemId: id('an item'), qty }))
    .min(1, 'Add at least one item'),
})

export const createRequisitionSchema = z.object({
  departmentId: id('the department asking'),
  moId: z.string().optional().nullable(),
  /**
   * One store for every line, as older callers send it. A line may name its
   * own instead — the form now picks the store per item, from where it is.
   */
  warehouseId: z.string().optional().nullable(),
  requiredDate: z.coerce.date().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  lines: z
    .array(
      z.object({
        itemId: id('an item'),
        requestedQty: qty,
        /** The store this line is asked of. Falls back to the requisition's. */
        warehouseId: z.string().optional().nullable(),
        purpose: z.string().max(300).optional().nullable(),
        /**
         * Whose material to draw. Defaults to ours, which is what every
         * requisition raised before customer material existed meant.
         */
        ownership: z.enum(['OWNED', 'CUSTOMER_OWNED']).optional(),
        ownerCustomerId: z.string().optional().nullable(),
      }),
    )
    .min(1, 'Add at least one item'),
})
  .superRefine((data, ctx) => {
    // A customer's material names the customer; our own names nobody. And one
    // line per item and owner: two lines drawing the same balance would both
    // be checked against the whole of it.
    const seen = new Set<string>()
    data.lines.forEach((l, i) => {
      if (!l.warehouseId && !data.warehouseId) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'warehouseId'], message: `Line ${i + 1}: pick the store to ask` })
      }
      const theirs = l.ownership === 'CUSTOMER_OWNED'
      if (theirs && !l.ownerCustomerId) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'ownerCustomerId'], message: `Line ${i + 1}: say whose material it is` })
      }
      const k = `${l.itemId}|${theirs ? l.ownerCustomerId : 'OWNED'}|${l.warehouseId ?? data.warehouseId}`
      if (seen.has(k)) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'itemId'], message: `Line ${i + 1}: that item is already asked for from the same stock. Put it on one line.` })
      }
      seen.add(k)
    })
  })

export const rejectRequisitionSchema = z.object({
  reason: z.string().min(5, 'Say why it is being refused').max(500),
})

/** Cancelling a requisition, or closing one part issued. The reason goes on it. */
export const closeRequisitionSchema = z.object({
  reason: z.string().trim().min(5, 'Say why it is no longer needed').max(500),
})

/**
 * Issuing against an approved requisition.
 *
 * Quantities are optional: leaving them out issues what was approved, which is
 * the normal case. Sending them lets the store hand over less when the rack is
 * short, without anyone having to raise a second requisition for the rest.
 */
export const issueRequisitionSchema = z.object({
  issueDate: z.coerce.date().optional(),
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1),
        issueQty: z
          .number({ invalid_type_error: 'Quantity has to be a number' })
          .min(0, 'Quantity cannot be negative'),
        /**
         * The store it comes out of. Defaults to the line's own. A line may
         * appear more than once, once per store, to be made up from several.
         */
        warehouseId: z.string().optional().nullable(),
      }),
    )
    .optional(),
})

/**
 * Taking a transfer back out.
 *
 * The reason is required for the same purpose as on any other cancellation: a
 * movement that was undone with no explanation is the one somebody has to go
 * and reconstruct from memory six months later.
 */
export const cancelTransferSchema = z.object({
  reason: z.string().min(5, 'Say why the transfer is being cancelled — one line is enough').max(500),
})

/**
 * A customer's own material arriving for us to work on.
 *
 * Every piece of the delivery paperwork is optional on purpose, the same way
 * the purchase goods receipt treats it: a receipt refused because the driver's
 * name was blank would put the stock figure behind the goods, and the goods are
 * already on the floor.
 */
export const createCustomerGrnSchema = z
  .object({
    customerId: id('the customer whose material this is'),
    /** Optional: a lorry can arrive before anybody raises the order. */
    soId: z.string().optional().nullable(),
    warehouseId: id('the store it went into'),
    receiptDate: z.coerce.date().optional(),
    challanNumber: z.string().max(50).optional().nullable(),
    challanDate: z.coerce.date().optional().nullable(),
    gateEntryNumber: z.string().max(50).optional().nullable(),
    gateEntryDate: z.coerce.date().optional().nullable(),
    vehicleNo: z.string().max(20, 'That vehicle number is too long').optional().nullable(),
    transporter: z.string().max(120).optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
    lines: z
      .array(
        z.object({
          itemId: id('an item'),
          /** What their challan says they sent. */
          challanQty: qty,
          /** What actually came off the lorry. */
          receivedQty: qty,
          batchNumber: z.string().max(50).optional().nullable(),
          markings: z.string().max(200).optional().nullable(),
        })
      )
      .min(1, 'Add at least one item'),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>()
    data.lines.forEach((line, i) => {
      if (seen.has(line.itemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'itemId'],
          message: 'This item is already on the receipt. Put the whole quantity on one line.',
        })
      }
      seen.add(line.itemId)
    })

    if (!data.lines.some((l) => l.receivedQty > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'Nothing was received. Enter what arrived on at least one line.',
      })
    }
  })

export const cancelCustomerGrnSchema = z.object({
  reason: z
    .string()
    .min(5, 'Say why the receipt is being cancelled — one line is enough')
    .max(500),
})

/** Why a customer's material is going back to them. */
export const CUSTOMER_RETURN_REASONS = ['LEFTOVER', 'REJECTED', 'EXCESS', 'OTHER'] as const

/**
 * A customer's own material going back to them unworked. Every line comes out
 * of one store, from that customer's balance of the item — the stock service
 * refuses more than is there, and says how much is.
 */
export const createCustomerReturnSchema = z
  .object({
    customerId: id('the customer it goes back to'),
    /** The receipt it came in on, when it is going back against one. */
    grnId: z.string().optional().nullable(),
    warehouseId: id('the store it leaves from'),
    returnDate: z.coerce.date().optional(),
    reason: z.enum(CUSTOMER_RETURN_REASONS, { errorMap: () => ({ message: 'Say why it is going back' }) }),
    vehicleNo: z.string().max(20, 'That vehicle number is too long').optional().nullable(),
    transporter: z.string().max(120).optional().nullable(),
    lrNumber: z.string().max(50).optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
    lines: z
      .array(
        z.object({
          itemId: id('an item'),
          qty: z.coerce.number().positive('Enter how much is going back').max(9_999_999),
          notes: z.string().max(200).optional().nullable(),
        }),
      )
      .min(1, 'Add at least one item'),
  })
  .superRefine((data, ctx) => {
    if (data.reason === 'OTHER' && !data.notes?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notes'], message: 'Say why it is going back' })
    }
    const seen = new Set<string>()
    data.lines.forEach((line, i) => {
      if (seen.has(line.itemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'itemId'],
          message: 'This item is already on the return. Put the whole quantity on one line.',
        })
      }
      seen.add(line.itemId)
    })
  })

export const cancelCustomerReturnSchema = z.object({
  reason: z
    .string()
    .min(5, 'Say why the return is being cancelled — one line is enough')
    .max(500),
})

/**
 * Our own fabric leaving for an outside unit.
 *
 * The process is required and free text. "What was it sent for" is the first
 * question anybody asks about fabric that has been out three weeks, and a
 * dropdown of processes would be out of date by the time the mill tried a new
 * one.
 */
export const createJobWorkChallanSchema = z
  .object({
    jobWorkerId: id('the unit doing the work'),
    process: z
      .string()
      .min(2, 'Say what the work is — cutting, stitching, dyeing')
      .max(200),
    fromWarehouseId: id('the store it leaves'),
    toWarehouseId: id("the store standing for the unit's floor"),
    challanDate: z.coerce.date().optional(),
    expectedBackOn: z.coerce.date().optional().nullable(),
    vehicleNo: z.string().max(20).optional().nullable(),
    transporter: z.string().max(120).optional().nullable(),
    lrNumber: z.string().max(50).optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
    lines: z
      .array(z.object({ itemId: id('an item'), qty }))
      .min(1, 'Add at least one item'),
  })
  .superRefine((data, ctx) => {
    if (data.fromWarehouseId === data.toWarehouseId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toWarehouseId'],
        message: 'The two stores are the same, so nothing would move.',
      })
    }

    const seen = new Set<string>()
    data.lines.forEach((line, i) => {
      if (seen.has(line.itemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'itemId'],
          message: 'This item is already on the challan. Put the whole quantity on one line.',
        })
      }
      seen.add(line.itemId)
    })
  })

export const cancelJobWorkChallanSchema = z.object({
  reason: z
    .string()
    .min(5, 'Say why the challan is being cancelled — one line is enough')
    .max(500),
})

/**
 * Goods coming back from an outside unit.
 *
 * `consumedQty` and `receivedQty` are separate because they are often different
 * things in different units: forty metres of fabric go out and three hundred cut
 * panels come back. What was used up leaves the unit's balance; what arrived
 * comes into ours; and anything the unit could not return is named as waste
 * rather than quietly absorbed.
 */
export const createJobWorkReturnSchema = z
  .object({
    challanId: id('the challan these goods went out on'),
    returnDate: z.coerce.date().optional(),
    vehicleNo: z.string().max(20).optional().nullable(),
    lrNumber: z.string().max(50).optional().nullable(),
    theirChallanNo: z.string().max(50).optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
    lines: z
      .array(
        z.object({
          challanLineId: z.string().min(1, 'Every line has to say what it came back against'),
          /** How much of what went out this row accounts for. */
          consumedQty: qty,
          /** What arrived. The same item unless the unit made something of it. */
          itemId: id('what came back'),
          receivedQty: z
            .number({ invalid_type_error: 'Quantity has to be a number' })
            .min(0, 'A quantity cannot be negative')
            .max(9_999_999, 'That quantity looks like a typo'),
          wastedQty: z
            .number({ invalid_type_error: 'Waste has to be a number' })
            .min(0, 'Waste cannot be negative')
            .max(9_999_999, 'That quantity looks like a typo')
            .optional(),
          warehouseId: id('the store it came back into'),
          notes: z.string().max(300).optional().nullable(),
        })
      )
      .min(1, 'Add at least one line'),
  })
  .superRefine((data, ctx) => {
    data.lines.forEach((line, i) => {
      if ((line.wastedQty ?? 0) > line.consumedQty) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'wastedQty'],
          message: `You cannot waste ${line.wastedQty} out of the ${line.consumedQty} that went out.`,
        })
      }
    })

    if (!data.lines.some((l) => l.consumedQty > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'Nothing came back. Enter what arrived on at least one line.',
      })
    }
  })
