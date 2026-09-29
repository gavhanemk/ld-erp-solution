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
        unitRate: rate,
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
        unitRate: rate.optional(),
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
  warehouseId: id('the store to draw from'),
  requiredDate: z.coerce.date().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  lines: z
    .array(
      z.object({
        itemId: id('an item'),
        requestedQty: qty,
        purpose: z.string().max(300).optional().nullable(),
      }),
    )
    .min(1, 'Add at least one item'),
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
