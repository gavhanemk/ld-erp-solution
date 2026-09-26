import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { applyRoundOff, nextDocumentNumber } from '../lib/docNumber'
import {
  priceNote,
  notedQtyByGrnLine,
  syncBillAdjustments,
} from '../services/purchaseNote.service'
import { syncEnquiryStatus } from '../services/purchaseEnquiry.service'
import { amountInWords, getPrintHeader } from '../lib/printData'
import {
  MAX_FILES_PER_DOCUMENT,
  MAX_FILE_BYTES,
  removeObject,
  signedDownloadUrl,
  signedUploadUrl,
  statObject,
  storagePathFor,
} from '../lib/storage'
import { recordMovement } from '../services/stock.service'
import {
  cancelGrnSchema,
  createGrnSchema,
  deleteGrnSchema,
  updateGrnSchema,
} from '../schemas/grn.schemas'
import {
  createBillSchema,
  updateBillSchema,
  type BillChargeInput,
  type BillLineInput,
} from '../schemas/bill.schemas'
import { createPaymentSchema } from '../schemas/payment.schemas'

const router = Router()
const MODULE = 'purchase'

/** Money is stored to two decimals; accumulating floats without rounding drifts. */
const round2 = (n: number) => Math.round(n * 100) / 100

const lineSchema = z.object({
  itemId: z.string().min(1, 'Pick an item'),
  description: z.string().max(300).optional().nullable(),
  /*
   * The garment style, both ways round: what the buyer typed, and the master
   * style it turned out to be. The browser sends both — it already has the
   * style list — and `styleId` is only set when the text matched a code
   * exactly, so nothing typed is ever dropped and the link is made whenever
   * it can be.
   */
  styleNo: z.string().max(50).optional().nullable(),
  styleId: z.string().optional().nullable(),
  qty: z.number().positive('Quantity must be more than zero'),
  unitRate: z.number().min(0, 'Rate cannot be negative'),
  discount: z.number().min(0).max(100).optional(),
  gstRate: z.number().min(0).max(100).optional(),
  /*
   * The requisition line this answers, when the buyer took it off the indent
   * list rather than typing it.
   *
   * Not checked against the item here on purpose. A buyer who orders a
   * substitute against an indent — a different thread, the same job — is
   * doing something ordinary, and refusing it would send them back to typing
   * the line by hand, which loses the link entirely.
   */
  mrLineId: z.string().optional().nullable(),
  /*
   * The enquiry line this rate came off, when the order was raised from an
   * enquiry. Checked against the order's own `enquiryId` on the way in, so a
   * line cannot quietly claim quantity off somebody else's enquiry.
   */
  enquiryLineId: z.string().optional().nullable(),
})

/**
 * One charge on the order — transport, freight, dyeing.
 *
 * Only the kind and the amount come from the browser. The GST rate is read
 * from the charge type on the server and frozen onto the row, so a rate the
 * form was holding from an hour ago cannot change what the order is taxed at.
 */
const chargeSchema = z.object({
  chargeTypeId: z.string().min(1, 'Pick a charge'),
  amount: z.number().min(0, 'A charge cannot be negative'),
})

const createSchema = z.object({
  supplierId: z.string().min(1, 'Pick a supplier'),
  poDate: z.coerce.date().optional(),
  deliveryDate: z.coerce.date().optional().nullable(),
  deliveryWarehouseId: z.string().optional().nullable(),
  /*
   * Which of the mill's three ways of ordering this is. It decides where a
   * discount is allowed to sit, which is why the buyer picks it before typing
   * any figures:
   *
   *   ITEM_LEVEL   a discount per line, the usual case
   *   ORDER_LEVEL  one discount off the whole order
   *   NONE         no discount at all
   *
   * An open string on the model, so the list is held here rather than in an
   * enum — the mill has renamed these before and a rename should not need a
   * migration.
   */
  poType: z.enum(['ITEM_LEVEL', 'ORDER_LEVEL', 'NONE']).optional(),
  // Ship straight to a customer instead of to one of our warehouses.
  deliveryCustomerId: z.string().optional().nullable(),
  /*
   * The enquiry this order is being raised from.
   *
   * Where it is given, `enquiryNo` and `enquiryDate` are filled from that
   * enquiry's proforma invoice rather than from the browser — the reference a
   * price is defended with has to come off the recorded document, not off a
   * form somebody could type anything into.
   */
  enquiryId: z.string().optional().nullable(),
  // Which quotation this order answers, and whatever the mill quotes back.
  // Free text on purpose: every mill numbers these its own way.
  enquiryNo: z.string().max(50).optional().nullable(),
  enquiryDate: z.coerce.date().optional().nullable(),
  /*
   * Which of the supplier's addresses this order is billed to.
   *
   * The id, not the text. The address that prints is rendered here from the
   * row, so a browser cannot put words on an order that no address says —
   * and the id is checked against this supplier, so one supplier's order
   * cannot be billed to another's premises.
   */
  supplierAddressId: z.string().optional().nullable(),
  reference: z.string().max(100).optional().nullable(),
  // Internal. `notes` is printed on the supplier's copy; this is not.
  remark: z.string().max(1000).optional().nullable(),
  discountAmount: z.number().min(0).optional(),
  charges: z.array(chargeSchema).max(20).optional(),
  // Carries no GST of its own and is added after tax, which is how the mill's
  // old system treated it.
  otherCharges: z.number().min(0).optional(),
  notes: z.string().max(1000).optional().nullable(),
  terms: z.string().max(4000).optional().nullable(),
  lines: z.array(lineSchema).min(1, 'An order needs at least one line'),
})

const updateSchema = createSchema.partial()

const poInclude = {
  supplier: {
    select: {
      id: true,
      name: true,
      code: true,
      gstin: true,
      stateCode: true,
      address: true,
      city: true,
      state: true,
      pincode: true,
      phone: true,
      email: true,
      // Printed on the order, so the supplier is told the terms they are being
      // held to rather than being left to assume them.
      paymentTerms: true,
      creditDays: true,
    },
  },
  charges: {
    include: { chargeType: { select: { id: true, name: true, defaultGstRate: true } } },
  },
  deliveryWarehouse: { select: { id: true, name: true, address: true } },
  deliveryCustomer: { select: { id: true, name: true, code: true, gstin: true } },
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  // A count, not the rows. The list only needs to say whether an order has
  // paperwork against it; fetching every file name for every order on the page
  // to decide whether to draw one paperclip would be a second query's worth of
  // data thrown away.
  _count: { select: { attachments: true } },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      style: { select: { id: true, code: true, name: true } },
      mrLine: {
        select: {
          id: true,
          requestedQty: true,
          mr: { select: { id: true, mrNumber: true } },
        },
      },
      shortClosedBy: { select: { id: true, name: true } },
      item: {
        select: {
          id: true,
          code: true,
          name: true,
          hsnCode: true,
          uom: { select: { symbol: true } },
          // The category, and its parent where it has one. An item sits in
          // whichever level it was filed under, so the parent is what the list
          // shows as the category and the item's own becomes the subcategory.
          category: {
            select: { id: true, name: true, parent: { select: { id: true, name: true } } },
          },
        },
      },
    },
  },
}

/**
 * For the "which order is this against" picker on the goods-receipt screen.
 *
 * That screen never reads a line, a charge, or who approved the order — only
 * the number, the supplier and where it was told to go. `poInclude` above
 * pulls every order's full item table to answer that, and on a supplier
 * sitting over the Supabase pooler each relation is its own round trip: a
 * hundred sent orders with ten lines apiece made the dropdown the slowest
 * thing on the screen. This is the same list with only what the picker draws.
 */
const poPickerInclude = {
  supplier: { select: { id: true, name: true } },
  deliveryWarehouse: { select: { id: true, name: true, address: true } },
}

/**
 * For booking goods in against one order.
 *
 * Receiving reads each line's quantity and its item, and nothing past that —
 * not the charges, not the style, not who approved the order. Fetched with
 * `poInclude` this one order alone cost as much as opening it for a full edit;
 * this trims it to the round trips receiving actually needs.
 */
const poReceivingInclude = {
  supplier: { select: { id: true, name: true } },
  deliveryWarehouse: { select: { id: true, name: true, address: true } },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      shortClosedBy: { select: { id: true, name: true } },
      item: {
        select: {
          id: true,
          code: true,
          name: true,
          hsnCode: true,
          uom: { select: { symbol: true } },
          category: {
            select: { id: true, name: true, parent: { select: { id: true, name: true } } },
          },
        },
      },
    },
  },
}

/**
 * Works out the tax split for a purchase.
 *
 * The supplier's state against ours decides whether they should bill us
 * CGST+SGST or IGST. Getting it wrong on the order means the bill that comes
 * back will not reconcile against it.
 */
async function purchaseTaxContext(
  tx: Prisma.TransactionClient,
  supplierId: string,
  /**
   * Where the goods actually land, when that is not our own address.
   *
   * Goods are taxed where they are delivered. Ask a supplier in Maharashtra to
   * ship straight to a customer in Gujarat and their bill is IGST, even though
   * we are in Maharashtra with them. Comparing the supplier against *us* would
   * call that CGST+SGST and the credit would be refused.
   */
  destinationStateCode?: string | null
) {
  const [company, supplier] = await Promise.all([
    tx.company.findFirst({ select: { stateCode: true, gstin: true } }),
    tx.supplier.findUnique({
      where: { id: supplierId },
      select: { stateCode: true, gstin: true, name: true },
    }),
  ])

  if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')

  const ourState = company?.stateCode || company?.gstin?.slice(0, 2)
  if (!ourState) {
    throw new AppError(
      'Your company GST state code is not set. Add it in Settings → Company, or the tax on this order will be wrong.',
      409,
      'NO_COMPANY_STATE'
    )
  }

  // A supplier with no GSTIN is unregistered; there is no split to make and the
  // order carries no tax, so this must not be treated as an error.
  const theirState = supplier.stateCode || supplier.gstin?.slice(0, 2) || null

  // Our own address unless the order says otherwise. Warehouses carry no state
  // of their own, so only a customer delivery can move it.
  const placeOfSupply = destinationStateCode || ourState

  return {
    ourState,
    theirState,
    placeOfSupply,
    isIntraState: theirState ? theirState === placeOfSupply : true,
    supplierIsUnregistered: !supplier.gstin,
  }
}

/**
 * The state the goods are going to, when they are going to a customer.
 *
 * Shipping beats billing, because that is where the goods physically land, and
 * the GSTIN is the last resort — its first two digits are the state code. If
 * none of the three is known the order is refused rather than guessed at: a
 * wrong split means the credit cannot be claimed, and that surfaces months
 * later as somebody else's problem.
 */
/**
 * The supplier's billing address, as one block of text, for the order to keep.
 *
 * Written onto the order rather than looked up when it prints: a supplier
 * moves, an address gets a typo corrected, one is retired — and none of that
 * may change what an order already sent to them says.
 *
 * Falls back to the supplier's default address, and then to the flat fields on
 * the supplier itself, so an order raised against a supplier nobody has given
 * addresses to still carries one.
 */
async function supplierBillingAddress(
  tx: Prisma.TransactionClient,
  supplierId: string,
  addressId?: string | null
): Promise<string | null> {
  const chosen = addressId
    ? await tx.supplierAddress.findUnique({ where: { id: addressId } })
    : null

  // Belonging is checked, not assumed. An id from another supplier would
  // otherwise print their premises on this order.
  if (addressId && (!chosen || chosen.supplierId !== supplierId)) {
    throw new AppError('That address does not belong to this supplier', 400, 'BAD_ADDRESS')
  }

  const row =
    chosen ??
    (await tx.supplierAddress.findFirst({
      where: { supplierId, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    }))

  if (row) {
    return (
      [row.address, row.city, row.state, row.pincode, row.country]
        .map((p) => p?.trim())
        .filter(Boolean)
        .join(', ') || null
    )
  }

  const supplier = await tx.supplier.findUnique({
    where: { id: supplierId },
    select: { address: true, city: true, state: true, pincode: true },
  })
  return (
    [supplier?.address, supplier?.city, supplier?.state, supplier?.pincode]
      .map((p) => p?.trim())
      .filter(Boolean)
      .join(', ') || null
  )
}

/**
 * The mill's own address for a goods receipt — the old system's "Shipping
 * Address". Where the lorry actually turned up, not where it came from.
 */
async function shippingAddressFor(
  tx: Prisma.TransactionClient,
  warehouseId?: string | null
): Promise<string | null> {
  if (!warehouseId) return null
  const warehouse = await tx.warehouse.findUnique({
    where: { id: warehouseId },
    select: { address: true },
  })
  if (!warehouse) throw new AppError('That store does not exist', 404, 'NOT_FOUND')
  return warehouse.address ?? null
}

async function customerDeliveryState(tx: Prisma.TransactionClient, customerId: string) {
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: {
      name: true,
      shippingStateCode: true,
      billingStateCode: true,
      shippingGstin: true,
      gstin: true,
      shippingAddress: true,
      shippingCity: true,
      shippingPincode: true,
      billingAddress: true,
      billingCity: true,
      billingPincode: true,
    },
  })
  if (!customer) throw new AppError('Customer not found', 404, 'NOT_FOUND')

  const stateCode =
    customer.shippingStateCode ||
    customer.billingStateCode ||
    customer.shippingGstin?.slice(0, 2) ||
    customer.gstin?.slice(0, 2)

  if (!stateCode) {
    throw new AppError(
      `No GST state code on ${customer.name}. Add one on the customer, or the tax on this order cannot be worked out.`,
      409,
      'NO_PLACE_OF_SUPPLY'
    )
  }

  // Frozen onto the order, because a customer moves and an order already with
  // a supplier must still say where it was sent.
  const address =
    [customer.shippingAddress, customer.shippingCity, customer.shippingPincode]
      .filter(Boolean)
      .join(', ') ||
    [customer.billingAddress, customer.billingCity, customer.billingPincode]
      .filter(Boolean)
      .join(', ') ||
    null

  return { stateCode, address, name: customer.name }
}

/**
 * `charges` arrive with their GST rate already read off the charge type — see
 * `resolveCharges`. They are taxed like a line but are not discountable: the
 * mill's discount is negotiated on the goods, not on the transporter's bill.
 *
 * `otherCharges` carries no GST and is added after tax, which is how the old
 * system treated it and how the printed sheet reads.
 */
function priceOrder(
  lines: z.infer<typeof lineSchema>[],
  discountAmount: number,
  isIntraState: boolean,
  chargeTax: boolean,
  charges: { chargeTypeId: string; amount: number; gstRate: number }[] = [],
  otherCharges = 0
) {
  const lineTotals = lines.map((l) => l.qty * l.unitRate * (1 - (l.discount ?? 0) / 100))
  const subtotal = round2(lineTotals.reduce((s, n) => s + n, 0))

  const discount = round2(Math.min(discountAmount, subtotal))
  const taxable = round2(subtotal - discount)
  const factor = subtotal > 0 ? taxable / subtotal : 1

  let cgst = 0
  let sgst = 0
  let igst = 0

  const split = (tax: number) => {
    if (isIntraState) {
      cgst += tax / 2
      sgst += tax / 2
    } else {
      igst += tax
    }
  }

  if (chargeTax) {
    lines.forEach((line, i) => {
      split(lineTotals[i] * factor * ((line.gstRate ?? 0) / 100))
    })
  }

  // Each charge's own tax, kept per charge so the row can be compared against
  // the same row on the bill when it arrives.
  const chargeRows = charges.map((c) => {
    const tax = chargeTax ? round2(c.amount * (c.gstRate / 100)) : 0
    split(tax)
    return {
      chargeTypeId: c.chargeTypeId,
      amount: round2(c.amount),
      gstRate: c.gstRate,
      cgst: isIntraState ? round2(tax / 2) : 0,
      sgst: isIntraState ? round2(tax / 2) : 0,
      igst: isIntraState ? 0 : round2(tax),
    }
  })

  const chargeTotal = round2(chargeRows.reduce((t, c) => t + c.amount, 0))

  cgst = round2(cgst)
  sgst = round2(sgst)
  igst = round2(igst)

  const { rounded, roundOff } = applyRoundOff(
    taxable + chargeTotal + cgst + sgst + igst + round2(otherCharges)
  )

  return {
    lineTotals,
    subtotal,
    discount,
    taxable,
    chargeRows,
    chargeTotal,
    otherCharges: round2(otherCharges),
    cgst,
    sgst,
    igst,
    roundOff,
    total: rounded,
  }
}

/**
 * Reads each charge's GST rate off the charge type, and refuses a kind of
 * charge the mill does not use on purchases.
 *
 * The rate is not taken from the browser on purpose: it is the difference
 * between an order taxed at 12% and one taxed at 18%, and the form could be
 * holding a rate that was corrected in the master since it loaded.
 */
async function resolveCharges(
  tx: Prisma.TransactionClient,
  charges: z.infer<typeof chargeSchema>[]
) {
  const wanted = charges.filter((c) => c.amount > 0)
  if (!wanted.length) return []

  const types = await tx.chargeType.findMany({
    where: { id: { in: wanted.map((c) => c.chargeTypeId) }, applyOnPurchase: true, isActive: true },
    select: { id: true, defaultGstRate: true },
  })
  const rateById = new Map(types.map((t) => [t.id, Number(t.defaultGstRate)]))

  const unknown = wanted.find((c) => !rateById.has(c.chargeTypeId))
  if (unknown) {
    throw new AppError(
      'One of those charges is not a charge the mill uses on purchases.',
      400,
      'INVALID_CHARGE'
    )
  }

  return wanted.map((c) => ({
    chargeTypeId: c.chargeTypeId,
    amount: c.amount,
    gstRate: rateById.get(c.chargeTypeId)!,
  }))
}

// ── Purchase orders ─────────────────────────────────────────────────────────

/**
 * What a new purchase order starts out carrying.
 *
 * Only the standard terms so far. They are read from the PO document template
 * — the same row the printed sheet reads — so the box on the form shows
 * exactly what would be printed if nothing were typed over it, rather than a
 * second copy of the wording kept somewhere else.
 *
 * Served from the purchase module rather than from settings on purpose. A
 * buyer raising an order is entitled to see the terms that order will carry,
 * and most buyers are not allowed into Settings at all — asking for it there
 * would hand them an empty box and no way to know why.
 *
 * Declared above `/orders/:id` because Express takes the first route that
 * matches and `defaults` would otherwise be read as an order id.
 */
router.get('/order-defaults', requirePermission(MODULE, 'view'), async (_req, res) => {
  const header = await getPrintHeader('PO')
  res.json({ success: true, data: { terms: header.template.termsText } })
})

/**
 * What this item has been bought at before.
 *
 * Newest first, one row per order line. The form shows the top one under the
 * Rate cell as "Last 1.10" and the whole list in a panel behind View history,
 * which is how the mill's old system did it and is the right shape for the
 * job: a purchase order rate is negotiated, so the buyer wants the last one in
 * front of them without it being typed into the box for them.
 *
 * Binned orders are left out. Cancelled ones are not — a rate that was
 * actually quoted is a real data point even if the order came to nothing, and
 * the status is returned so the panel can say which is which rather than
 * quietly presenting them as equal.
 *
 * Declared above `/orders` for no reason other than keeping the purchase order
 * routes together below it.
 */
router.get(
  '/rate-history/:itemId',
  requirePermission(MODULE, 'view'),
  async (req: AuthRequest, res) => {
    const rows = await prisma.purchaseOrderLine.findMany({
      where: { itemId: req.params.itemId, po: { deletedAt: null } },
      orderBy: [{ po: { poDate: 'desc' } }, { po: { createdAt: 'desc' } }],
      take: 50,
      select: {
        id: true,
        qty: true,
        unitRate: true,
        amount: true,
        po: {
          select: {
            poNumber: true,
            poDate: true,
            status: true,
            supplier: { select: { name: true } },
          },
        },
      },
    })

    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        poNumber: r.po.poNumber,
        poDate: r.po.poDate,
        status: r.po.status,
        supplierName: r.po.supplier.name,
        qty: r.qty,
        unitRate: r.unitRate,
        amount: r.amount,
      })),
    })
  }
)

/**
 * The indent lines still waiting to be ordered.
 *
 * The mill's old ERP opens this as a modal off the purchase order form —
 * "Select Items From Indent Items" — and the buyer ticks what they are about
 * to place, rather than typing item codes somebody in production already
 * typed. Three things come out of that, and all three are the point:
 *
 *   - Nothing is ordered twice. What has already been ordered against a
 *     request is subtracted here, so the figure offered is what is left.
 *   - Nothing is forgotten. A request that has not been ordered stays on this
 *     list until it has.
 *   - Every purchase has a reason. The line carries the requisition, and the
 *     requisition carries the job.
 *
 * Ordered quantity is summed off the order lines rather than kept as a
 * counter. A counter and the orders it counts disagree the first time an order
 * is cancelled, and then the buyer is told to order what they already ordered.
 * Cancelled orders are excluded for the same reason: an order that was called
 * off has bought nothing.
 *
 * Only approved requisitions. An indent nobody has signed off is a wish, and
 * committing the mill's money to a wish is how the buyer ends up holding
 * something nobody will own.
 */
router.get('/indent-items', requirePermission(MODULE, 'view'), async (req, res) => {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

  const mrNumber = text(req.query.mrNumber)
  const itemId = text(req.query.itemId)
  const moId = text(req.query.moId)
  // Off by default: somebody who has just ordered part of a request usually
  // wants to see what is left, not the rows that are done.
  const includeDone = req.query.includeDone === 'true'

  const lines = await prisma.materialRequisitionLine.findMany({
    where: {
      fulfilment: 'PURCHASE',
      ...(itemId ? { itemId } : {}),
      mr: {
        status: 'APPROVED',
        ...(mrNumber ? { mrNumber: { contains: mrNumber, mode: 'insensitive' } } : {}),
        ...(moId ? { moId } : {}),
      },
    },
    include: {
      item: {
        select: {
          id: true,
          code: true,
          name: true,
          hsnCode: true,
          // The rate the form should offer for this item, so a line lifted off
          // an indent arrives taxed rather than at zero.
          taxRate: { select: { id: true, rate: true } },
          uom: { select: { symbol: true } },
        },
      },
      warehouse: { select: { id: true, name: true } },
      mr: {
        select: {
          id: true,
          mrNumber: true,
          requestDate: true,
          requiredDate: true,
          notes: true,
          department: { select: { id: true, name: true } },
          mo: { select: { id: true, moNumber: true } },
        },
      },
      poLines: {
        where: { po: { status: { not: 'CANCELLED' } } },
        select: { qty: true },
      },
      /*
       * What is already out with a supplier as a question.
       *
       * Counted so the buyer can see it, and subtracted from nothing. An
       * enquiry is not a purchase: if it reduced what the request still needs,
       * a request that had only been asked about would read as bought, and the
       * line would drop off this very list before anybody had agreed to supply
       * it. What it prevents is the opposite mistake — enquiring twice about
       * the same request because the first enquiry left no mark here.
       *
       * Closed enquiries are left out. A dropped enquiry is not out with
       * anybody, and showing it would stop the buyer raising a new one.
       */
      enquiryLines: {
        where: { enquiry: { status: { notIn: ['CLOSED'] }, deletedAt: null } },
        select: { qty: true },
      },
    },
    orderBy: [{ mr: { requestDate: 'asc' } }, { id: 'asc' }],
  })

  const rows = lines
    .map((l) => {
      const requested = Number(l.requestedQty)
      const ordered = round3(l.poLines.reduce((t, p) => t + Number(p.qty), 0))
      const enquired = round3(l.enquiryLines.reduce((t, e) => t + Number(e.qty), 0))
      return {
        mrLineId: l.id,
        mrId: l.mr.id,
        mrNumber: l.mr.mrNumber,
        requestDate: l.mr.requestDate,
        requiredDate: l.mr.requiredDate,
        department: l.mr.department,
        // Named the way the old screen names them, so the two read the same to
        // somebody moving across. There is no sales order in this system yet;
        // the column stays empty rather than being left out, because it is
        // coming.
        moNumber: l.mr.mo?.moNumber ?? null,
        soNumber: null as string | null,
        remark: l.purpose ?? l.mr.notes ?? null,
        item: l.item,
        warehouse: l.warehouse,
        indentQty: requested,
        orderedQty: ordered,
        /*
         * Out for enquiry. Shown beside the pending figure, never inside it —
         * `pendingQty` is what is still to be ORDERED, and it is what decides
         * whether this row stays on the list.
         */
        enquiredQty: enquired,
        pendingQty: round3(Math.max(0, requested - ordered)),
      }
    })
    .filter((r) => includeDone || r.pendingQty > 0)

  res.json({ success: true, data: rows })
})

router.get('/orders', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))

  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const q = text(req.query.q)
  const itemId = text(req.query.itemId)
  const from = text(req.query.from)
  const to = text(req.query.to)

  // Binned orders are not in any list. The recycle bin has a route of its
  // own, so no screen can show them by forgetting to pass something.
  const where: Prisma.PurchaseOrderWhereInput = { deletedAt: null }
  if (typeof req.query.status === 'string' && req.query.status) {
    where.status = req.query.status as Prisma.PurchaseOrderWhereInput['status']
  }
  if (typeof req.query.supplierId === 'string' && req.query.supplierId) {
    where.supplierId = req.query.supplierId
  }
  // `some`, not `every`: a ten-line order with thread on it somewhere is
  // still an order with thread on it.
  if (itemId) where.lines = { some: { itemId } }

  /*
   * A day range, inclusive at both ends.
   *
   * `to` is pushed to the end of its day. An order raised at four in the
   * afternoon on the 19th belongs to the 19th, and a range ending on the
   * 19th that left it out would be a filter quietly losing the day asked for.
   */
  if (from || to) {
    const range: Prisma.DateTimeFilter = {}
    if (from) range.gte = new Date(`${from}T00:00:00`)
    if (to) range.lte = new Date(`${to}T23:59:59.999`)
    where.poDate = range
  }
  if (q) {
    where.OR = [
      { poNumber: { contains: q, mode: 'insensitive' } },
      { supplier: { name: { contains: q, mode: 'insensitive' } } },
    ]
  }

  const picker = req.query.view === 'picker'
  const [rows, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: picker ? poPickerInclude : poInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.purchaseOrder.count({ where }),
  ])

  /*
   * The picker never reads a line, so it has nothing to enrich. Everywhere
   * else — the order list itself, and the "waiting for goods" queue the
   * receiving screen builds from this same route — a line's rejected
   * quantity is worked out here rather than left for the caller to guess:
   * it lives on the receipts, not on the order.
   */
  let data: unknown = rows
  if (!picker) {
    const withLines = rows as unknown as Array<{
      lines: Array<Record<string, unknown> & { id: string }>
    }>
    const rejected = await rejectedByPoLine(
      prisma,
      withLines.flatMap((po) => po.lines.map((l) => l.id))
    )
    data = withLines.map((po) => ({
      ...po,
      lines: po.lines.map((l) => ({ ...l, rejectedQty: rejected.get(l.id) ?? 0 })),
    }))
  }

  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/orders/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    include: req.query.view === 'receiving' ? poReceivingInclude : poInclude,
  })
  if (!po || po.deletedAt) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: po })
})

/** Everything the printed sheet needs, in one call. */
router.get('/orders/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    include: poInclude,
  })
  if (!po || po.deletedAt) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')

  const header = await getPrintHeader('PO')

  res.json({
    success: true,
    data: {
      ...header,
      order: po,
      totalInWords: amountInWords(Number(po.totalAmount)),
      // Which tax columns to print. A purchase from an unregistered supplier
      // carries no GST at all, and showing empty columns invites the question
      // of whether something was forgotten.
      taxMode: Number(po.igst) > 0 ? 'IGST' : Number(po.cgst) > 0 ? 'CGST_SGST' : 'NONE',
    },
  })
})

router.post('/orders', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createSchema.parse(req.body)

  /*
   * The enquiry this order is being raised from, if any.
   *
   * Three things are checked, and each of them is a way the link could be a
   * lie rather than a reference:
   *
   *   - it exists and is not in the bin, or the order points at nothing;
   *   - it belongs to this supplier, or one supplier's order would be quoting
   *     a price another supplier gave;
   *   - it is not closed, because a closed enquiry is a decision not to buy
   *     and an order against one is somebody working from a stale screen.
   *
   * An expired PI is deliberately NOT refused. The validity is the supplier's
   * own statement about how long he will hold the rate, not a rule of ours, and
   * he frequently honours it anyway — so the order carries a warning on screen
   * and goes through. Refusing it would leave the buyer retyping the whole
   * order by hand to place something the supplier has already agreed to.
   */
  const enquiry = data.enquiryId
    ? await prisma.purchaseEnquiry.findUnique({
        where: { id: data.enquiryId },
        select: {
          id: true,
          enquiryNumber: true,
          supplierId: true,
          status: true,
          deletedAt: true,
          piNumber: true,
          piDate: true,
          lines: { select: { id: true } },
        },
      })
    : null

  if (data.enquiryId) {
    if (!enquiry || enquiry.deletedAt) {
      throw new AppError('That enquiry no longer exists', 400, 'BAD_ENQUIRY')
    }
    if (enquiry.supplierId !== data.supplierId) {
      throw new AppError(
        `${enquiry.enquiryNumber} was sent to a different supplier. An order can only be raised ` +
          `from an enquiry to the supplier it is being placed with.`,
        400,
        'ENQUIRY_WRONG_SUPPLIER'
      )
    }
    if (enquiry.status === 'CLOSED') {
      throw new AppError(
        `${enquiry.enquiryNumber} is closed. Reopen it before ordering against it.`,
        409,
        'ENQUIRY_CLOSED'
      )
    }

    const mine = new Set(enquiry.lines.map((l) => l.id))
    for (const l of data.lines) {
      if (l.enquiryLineId && !mine.has(l.enquiryLineId)) {
        throw new AppError(
          `One of those lines points at an enquiry line that is not on ${enquiry.enquiryNumber}`,
          400,
          'ENQUIRY_WRONG_LINE'
        )
      }
    }
  } else if (data.lines.some((l) => l.enquiryLineId)) {
    throw new AppError(
      'A line cannot come off an enquiry unless the order says which enquiry',
      400,
      'ENQUIRY_LINE_WITHOUT_ENQUIRY'
    )
  }

  const po = await prisma.$transaction(async (tx) => {
    // A back-dated order belongs to its own financial year's series.
    const poNumber = await nextDocumentNumber(tx, 'PO', data.poDate ?? new Date())

    // Where the goods land decides the tax, so this has to be settled before
    // anything is priced.
    const destination = data.deliveryCustomerId
      ? await customerDeliveryState(tx, data.deliveryCustomerId)
      : null

    const tax = await purchaseTaxContext(tx, data.supplierId, destination?.stateCode)

    // HSN is copied onto the line now, so an order already sent to a supplier
    // does not change if the item master is corrected next week.
    const items = await tx.item.findMany({
      where: { id: { in: data.lines.map((l) => l.itemId) } },
      select: { id: true, hsnCode: true },
    })
    const hsnById = new Map(items.map((i) => [i.id, i.hsnCode]))
    if (items.length !== new Set(data.lines.map((l) => l.itemId)).size) {
      throw new AppError('One of those items no longer exists', 400, 'INVALID_ITEM')
    }

    const charges = await resolveCharges(tx, data.charges ?? [])

    const priced = priceOrder(
      data.lines,
      data.discountAmount ?? 0,
      tax.isIntraState,
      !tax.supplierIsUnregistered,
      charges,
      data.otherCharges ?? 0
    )

    return tx.purchaseOrder.create({
      data: {
        poNumber,
        supplierId: data.supplierId,
        poType: data.poType ?? 'ITEM_LEVEL',
        poDate: data.poDate ?? new Date(),
        deliveryDate: data.deliveryDate ?? undefined,
        deliveryWarehouseId: data.deliveryWarehouseId || null,
        deliveryCustomerId: data.deliveryCustomerId || null,
        deliveryAddress: destination?.address ?? null,
        supplierAddress: await supplierBillingAddress(tx, data.supplierId, data.supplierAddressId),
        enquiryId: enquiry?.id ?? null,
        /*
         * The supplier's own PI number wins over anything typed.
         *
         * This is the field printed on the order he receives, and quoting his
         * reference back to him is the whole point of the enquiry step. What
         * was typed is only used when there is no enquiry behind the order —
         * answering a quote that never became one on this system.
         */
        enquiryNo: enquiry?.piNumber ?? data.enquiryNo ?? null,
        enquiryDate: enquiry?.piDate ?? data.enquiryDate ?? null,
        reference: data.reference ?? null,
        remark: data.remark ?? null,
        placeOfSupplyCode: tax.placeOfSupply,
        subtotal: priced.subtotal,
        discountAmount: priced.discount,
        taxableAmount: priced.taxable,
        cgst: priced.cgst,
        sgst: priced.sgst,
        igst: priced.igst,
        roundOff: priced.roundOff,
        otherCharges: priced.otherCharges,
        totalAmount: priced.total,
        notes: data.notes ?? null,
        terms: data.terms ?? null,
        createdById: req.user!.id,
        charges: { create: priced.chargeRows },
        lines: {
          create: data.lines.map((l, i) => ({
            itemId: l.itemId,
            description: l.description ?? null,
            styleNo: l.styleNo?.trim() || null,
            styleId: l.styleId || null,
            mrLineId: l.mrLineId || null,
            enquiryLineId: l.enquiryLineId || null,
            hsnCode: hsnById.get(l.itemId) ?? null,
            qty: l.qty,
            unitRate: l.unitRate,
            discount: l.discount ?? 0,
            gstRate: tax.supplierIsUnregistered ? 0 : (l.gstRate ?? 0),
            amount: round2(priced.lineTotals[i]),
            pendingQty: l.qty,
            sortOrder: i,
          })),
        },
      },
      include: poInclude,
    })
  })

  // The enquiry's status is derived, so it has to be recomputed now that an
  // order stands on it. Outside the transaction above deliberately: the order
  // is the document that matters, and a failure to relabel the enquiry must not
  // roll back an order that saved correctly.
  if (enquiry) await syncEnquiryStatus(prisma, enquiry.id)

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'PurchaseOrder',
    entityId: po.id,
    after: po,
  })

  res.status(201).json({ success: true, data: po })
})

router.patch('/orders/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = updateSchema.parse(req.body)

  const before = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    include: poInclude,
  })
  if (!before || before.deletedAt) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')

  // A draft is our own paper, and an order that has only been sent is paper on
  // the supplier's desk — both can still be corrected, and the buyer is told
  // to send the new copy afterwards. What cannot be corrected is an order
  // something has already arrived against.
  //
  // That is not caution, it is the schema: this edit replaces the lines
  // wholesale, and `grn_lines.poLineId` is ON DELETE SET NULL. Every receipt
  // line pointing at a replaced order line would be cut loose without a word,
  // and ordered-versus-received is summed through exactly that column.
  if (before.status !== 'DRAFT' && before.status !== 'SENT') {
    throw new AppError(
      `This order is ${before.status.toLowerCase().replace('_', ' ')} and can no longer be edited. Raise a new one.`,
      400,
      'PO_NOT_EDITABLE'
    )
  }

  // Belt and braces for the case the status alone misses: a receipt that was
  // cancelled puts the order back to SENT while its lines still point here.
  const arrived = await prisma.gRNLine.count({ where: { poLine: { poId: before.id } } })
  if (arrived > 0) {
    throw new AppError(
      'Goods have been booked against this order, so its lines can no longer be changed. Correct the receipt instead, or raise a fresh order for the difference.',
      400,
      'PO_HAS_RECEIPTS'
    )
  }

  // The header fields are written by both paths below — with new lines and
  // without. Kept in one place so a field added to one cannot be forgotten in
  // the other, which is how an edit ends up saving on some screens only.
  const headerPatch = {
    ...(data.poType !== undefined ? { poType: data.poType } : {}),
    ...(data.poDate ? { poDate: data.poDate } : {}),
    ...(data.deliveryDate !== undefined ? { deliveryDate: data.deliveryDate ?? null } : {}),
    ...(data.deliveryWarehouseId !== undefined
      ? { deliveryWarehouseId: data.deliveryWarehouseId || null }
      : {}),
    ...(data.deliveryCustomerId !== undefined
      ? { deliveryCustomerId: data.deliveryCustomerId || null }
      : {}),
    ...(data.enquiryNo !== undefined ? { enquiryNo: data.enquiryNo ?? null } : {}),
    ...(data.enquiryDate !== undefined ? { enquiryDate: data.enquiryDate ?? null } : {}),
    ...(data.reference !== undefined ? { reference: data.reference ?? null } : {}),
    ...(data.remark !== undefined ? { remark: data.remark ?? null } : {}),
    ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
    ...(data.terms !== undefined ? { terms: data.terms ?? null } : {}),
  }

  const after = await prisma.$transaction(async (tx) => {
    if (data.lines) {
      // Changing who it is delivered to changes the tax, so the destination is
      // resolved again rather than carried over from when it was first raised.
      const customerId =
        data.deliveryCustomerId !== undefined ? data.deliveryCustomerId : before.deliveryCustomerId
      const destination = customerId ? await customerDeliveryState(tx, customerId) : null
      const tax = await purchaseTaxContext(
        tx,
        data.supplierId ?? before.supplierId,
        destination?.stateCode
      )
      const items = await tx.item.findMany({
        where: { id: { in: data.lines.map((l) => l.itemId) } },
        select: { id: true, hsnCode: true },
      })
      const hsnById = new Map(items.map((i) => [i.id, i.hsnCode]))

      /*
       * Charges are replaced wholesale, like the lines, and only when the edit
       * mentions them. An edit that sends no `charges` key leaves the ones the
       * order already carries alone rather than clearing them — the same rule
       * the header fields follow.
       */
      const charges =
        data.charges !== undefined
          ? await resolveCharges(tx, data.charges)
          : before.charges.map((c) => ({
              chargeTypeId: c.chargeTypeId,
              amount: Number(c.amount),
              gstRate: Number(c.gstRate),
            }))

      const priced = priceOrder(
        data.lines,
        data.discountAmount ?? Number(before.discountAmount),
        tax.isIntraState,
        !tax.supplierIsUnregistered,
        charges,
        data.otherCharges ?? Number(before.otherCharges)
      )

      await tx.purchaseOrderCharge.deleteMany({ where: { poId: before.id } })
      if (priced.chargeRows.length) {
        await tx.purchaseOrderCharge.createMany({
          data: priced.chargeRows.map((c) => ({ poId: before.id, ...c })),
        })
      }

      await tx.purchaseOrderLine.deleteMany({ where: { poId: before.id } })
      await tx.purchaseOrderLine.createMany({
        data: data.lines.map((l, i) => ({
          poId: before.id,
          itemId: l.itemId,
          description: l.description ?? null,
          styleNo: l.styleNo?.trim() || null,
          styleId: l.styleId || null,
          mrLineId: l.mrLineId || null,
          hsnCode: hsnById.get(l.itemId) ?? null,
          qty: l.qty,
          unitRate: l.unitRate,
          discount: l.discount ?? 0,
          gstRate: tax.supplierIsUnregistered ? 0 : (l.gstRate ?? 0),
          amount: round2(priced.lineTotals[i]),
          pendingQty: l.qty,
          sortOrder: i,
        })),
      })

      return tx.purchaseOrder.update({
        where: { id: before.id },
        data: {
          ...headerPatch,
          ...(data.supplierId ? { supplierId: data.supplierId } : {}),
          placeOfSupplyCode: tax.placeOfSupply,
          deliveryAddress: destination?.address ?? null,
          supplierAddress: await supplierBillingAddress(
            tx,
            before.supplierId,
            data.supplierAddressId
          ),
          subtotal: priced.subtotal,
          discountAmount: priced.discount,
          taxableAmount: priced.taxable,
          cgst: priced.cgst,
          sgst: priced.sgst,
          igst: priced.igst,
          roundOff: priced.roundOff,
          otherCharges: priced.otherCharges,
          totalAmount: priced.total,
        },
        include: poInclude,
      })
    }

    return tx.purchaseOrder.update({
      where: { id: before.id },
      data: headerPatch,
      include: poInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseOrder',
    entityId: after.id,
    before,
    after,
  })

  res.json({ success: true, data: after })
})

/** Marks the order as sent to the supplier. From here it can no longer be edited. */
router.patch(
  '/orders/:id/send',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const before = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } })
    if (!before || before.deletedAt)
      throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
    if (before.status !== 'DRAFT') {
      throw new AppError('Only a draft order can be sent', 400, 'PO_NOT_DRAFT')
    }

    const after = await prisma.purchaseOrder.update({
      where: { id: before.id },
      data: { status: 'SENT' },
      include: poInclude,
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'PurchaseOrder',
      entityId: after.id,
      before,
      after,
    })

    res.json({ success: true, data: after, message: `${after.poNumber} marked as sent.` })
  }
)

router.patch(
  '/orders/:id/cancel',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const reason = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {})

    const before = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } })
    if (!before || before.deletedAt)
      throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
    if (before.status === 'COMPLETED') {
      throw new AppError('A completed order cannot be cancelled', 400, 'PO_COMPLETED')
    }

    const after = await prisma.purchaseOrder.update({
      where: { id: before.id },
      data: {
        status: 'CANCELLED',
        notes: reason.reason
          ? `${before.notes ? before.notes + '\n' : ''}Cancelled: ${reason.reason}`
          : before.notes,
      },
      include: poInclude,
    })

    /*
     * A cancelled order releases its enquiry.
     *
     * This is the case the derived status exists for: the quantity this order
     * claimed goes straight back to being quoted but unplaced, and an enquiry
     * with nothing else on it drops from ORDERED back to QUOTED — so the buyer
     * can raise a corrected order from the same PI instead of starting again.
     */
    if (before.enquiryId) await syncEnquiryStatus(prisma, before.enquiryId)

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'PurchaseOrder',
      entityId: after.id,
      before,
      after,
    })

    res.json({ success: true, data: after, message: `${after.poNumber} cancelled.` })
  }
)

const shortCloseSchema = z.object({
  reason: z
    .string()
    .min(5, 'Say why the rest of this line is not coming — one line is enough')
    .max(500),
})

/**
 * Tells one line of an order that the rest of it is not coming.
 *
 * Nothing forces a supplier to make up a shortfall, and an order sitting
 * "Partially Received" forever because 40kg of a 2,000kg line never turned up
 * is a pending-order report that never clears and a buyer who has to
 * remember, months later, that this one is actually done. Closing the line
 * says so on purpose: `pendingQty` drops to 0, `receivedQty` is untouched —
 * the shortfall is recorded as never received, not quietly counted as if it
 * were — and the order's own status is recomputed the same way a receipt
 * would recompute it, so a line closed last reaches COMPLETED exactly like a
 * line received last would.
 *
 * Refused once nothing is actually outstanding (there is nothing to close)
 * and once the line is closed already (say so, do not error). Reversible —
 * see the route below — because a supplier who turns up eight weeks late with
 * the balance should not have to go through a new order to deliver it.
 */
router.patch(
  '/orders/:id/lines/:lineId/short-close',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { reason } = shortCloseSchema.parse(req.body)

    // Whether this is a genuine shortfall or an outright cancellation reads
    // off what had already arrived before this line was closed — not a
    // second field to keep in step with the first, but the same fact the
    // reader already sees as "Received" on the line above.
    let neverReceived = false

    const after = await prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!po || po.deletedAt) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
      if (po.status !== 'SENT' && po.status !== 'PARTIALLY_RECEIVED') {
        throw new AppError(
          `${po.poNumber} is ${po.status.toLowerCase().replace('_', ' ')} — only a sent order with goods still due can be closed short.`,
          400,
          'PO_NOT_RECEIVABLE'
        )
      }

      const line = po.lines.find((l) => l.id === req.params.lineId)
      if (!line) throw new AppError('That line is not on this order', 404, 'NOT_FOUND')
      if (line.shortClosed) {
        throw new AppError('This line is already closed short.', 400, 'ALREADY_CLOSED')
      }
      if (Number(line.pendingQty) <= 0) {
        throw new AppError('Everything on this line has already been received — there is nothing to close.', 400, 'NOTHING_PENDING')
      }
      neverReceived = Number(line.receivedQty) <= 0

      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        data: {
          shortClosed: true,
          shortCloseReason: reason,
          shortClosedAt: new Date(),
          shortClosedById: req.user!.id,
        },
      })

      return syncOrderFromReceipts(tx, po.id)
    })

    const full = await prisma.purchaseOrder.findUnique({ where: { id: after.id }, include: poInclude })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'PurchaseOrder',
      entityId: after.id,
      after: full,
    })

    res.json({
      success: true,
      data: full,
      message: neverReceived
        ? 'Line cancelled. Nothing was ever received against it, and it will not count as pending any more.'
        : 'Line closed short. It will not count as pending any more.',
    })
  }
)

/** Undoes a short-close — the supplier turned up with the balance after all. */
router.patch(
  '/orders/:id/lines/:lineId/reopen',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const after = await prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!po || po.deletedAt) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')

      const line = po.lines.find((l) => l.id === req.params.lineId)
      if (!line) throw new AppError('That line is not on this order', 404, 'NOT_FOUND')
      if (!line.shortClosed) throw new AppError('This line is not closed short', 400, 'NOT_CLOSED')

      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        data: {
          shortClosed: false,
          shortCloseReason: null,
          shortClosedAt: null,
          shortClosedById: null,
        },
      })

      return syncOrderFromReceipts(tx, po.id)
    })

    const full = await prisma.purchaseOrder.findUnique({ where: { id: after.id }, include: poInclude })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'PurchaseOrder',
      entityId: after.id,
      after: full,
    })

    res.json({ success: true, data: full, message: 'Line reopened — it counts as pending again.' })
  }
)

/**
 * Puts a purchase order in the recycle bin.
 *
 * The row is marked, not removed. Every list, count and lookup outside the bin
 * passes over a marked order, so as far as the mill is concerned it is gone —
 * but the lines, the charges and the files are all still there, which is what
 * makes putting it back a single field rather than a reconstruction.
 *
 * Cancelling is still the right end for a real order that fell through: a
 * cancelled order goes on saying what was asked for and when it was called
 * off. This is for the ones that should not exist — a duplicate, a mis-key,
 * the rows left over from setting the system up.
 *
 * Two things are refused:
 *
 * - An order that has been sent. The supplier is holding paper for it, and
 *   taking our copy out of every list leaves them quoting a number nobody here
 *   can find. Cancel it, so both sides still have the same document.
 * - An order with a goods receipt or a bill against it. Those are real
 *   movements of stock and money pointing back at this order, and hiding what
 *   they point at would leave them explaining themselves against nothing.
 *
 * The number is not given back either way. The series only counts up: handing
 * 0001 out twice because the first was binned would put two different orders
 * on one number in two people's records, and a restore would then collide with
 * whatever had taken it.
 */
/**
 * Pulls a sent order back to draft so it can be corrected and sent again.
 *
 * The rule this bends is a real one and it is printed on the sheet: once an
 * order has gone to a supplier, they are working from paper, and quietly
 * changing the order underneath them is how a mill ends up arguing about what
 * was agreed. So this is not "edit a sent order" — it is a deliberate,
 * recorded step backwards, and the audit log carries who did it and when. The
 * supplier's copy is out of date from that moment, and whoever reopened it
 * knows that because they had to ask for it.
 *
 * Refused once anything has been booked against the order. A goods receipt or
 * a bill is somebody else's document and it reconciles line by line against
 * this one; letting the order move under a receipt that has already increased
 * stock would put the two permanently out of step. Those orders can still be
 * cancelled, which is the honest way out.
 */
router.patch(
  '/orders/:id/reopen',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { grns: true, invoices: true } } },
    })
    if (!order || order.deletedAt) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')

    if (order.status === 'DRAFT') {
      throw new AppError(
        `${order.poNumber} is already a draft — open it and make the change.`,
        400,
        'PO_ALREADY_DRAFT'
      )
    }

    /*
     * Only from SENT. A cancelled order is closed on purpose and a completed
     * one has been received in full; both have somebody's decision behind them
     * that reopening would quietly undo.
     */
    if (order.status !== 'SENT') {
      throw new AppError(
        `${order.poNumber} is ${order.status.toLowerCase().replace(/_/g, ' ')}, and only a sent order can be reopened.`,
        400,
        'PO_NOT_SENT'
      )
    }

    if (order._count.grns > 0 || order._count.invoices > 0) {
      const against = [
        order._count.grns > 0 &&
          `${order._count.grns} goods receipt${order._count.grns > 1 ? 's' : ''}`,
        order._count.invoices > 0 &&
          `${order._count.invoices} bill${order._count.invoices > 1 ? 's' : ''}`,
      ]
        .filter(Boolean)
        .join(' and ')
      throw new AppError(
        `${order.poNumber} has ${against} against it and can no longer be reopened — those would stop matching it. Cancel it and raise a new one instead.`,
        409,
        'PO_HAS_DOCUMENTS'
      )
    }

    const after = await prisma.purchaseOrder.update({
      where: { id: order.id },
      data: { status: 'DRAFT' },
      include: poInclude,
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'PurchaseOrder',
      entityId: order.id,
      before: order,
      after,
    })

    res.json({
      success: true,
      data: after,
      message: `${order.poNumber} is a draft again. The supplier's copy is now out of date — send it again when you have finished.`,
    })
  }
)

router.delete('/orders/:id', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { grns: true, invoices: true } } },
  })
  if (!order || order.deletedAt) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')

  // No status check here any more. An order the supplier holds used to be
  // refused outright, but the check below is the one that actually protects
  // anything: an order nothing has arrived against and nothing has been
  // billed against holds no history worth keeping. This is a soft delete —
  // the order goes to the recycle bin and its number is still never reused —
  // so an order sent by mistake can be taken off the list, and recovered if
  // that turns out to be wrong. Cancelling stays the right answer for an
  // order that was real and fell through, and the wording on the button says
  // which is which.

  if (order._count.grns > 0 || order._count.invoices > 0) {
    const against = [
      order._count.grns > 0 &&
        `${order._count.grns} goods receipt${order._count.grns > 1 ? 's' : ''}`,
      order._count.invoices > 0 &&
        `${order._count.invoices} bill${order._count.invoices > 1 ? 's' : ''}`,
    ]
      .filter(Boolean)
      .join(' and ')
    throw new AppError(
      `${order.poNumber} has ${against} against it, so it cannot be deleted. Cancel it instead.`,
      409,
      'PO_HAS_DOCUMENTS'
    )
  }

  const after = await prisma.purchaseOrder.update({
    where: { id: order.id },
    data: { deletedAt: new Date(), deletedById: req.user?.id ?? null },
  })

  // A binned order stops standing on its enquiry, the same as a cancelled one.
  if (order.enquiryId) await syncEnquiryStatus(prisma, order.enquiryId)

  await writeAuditLog(req, {
    module: MODULE,
    action: 'DELETE',
    entityType: 'PurchaseOrder',
    entityId: order.id,
    before: order,
    after,
  })

  res.json({ success: true, message: `${order.poNumber} moved to the recycle bin.` })
})

/**
 * What is in the recycle bin.
 *
 * Its own route rather than a flag on the orders list, so that no screen can
 * show binned orders by forgetting to pass something. Reading the bin is an
 * act of its own and has to be asked for by name.
 */
router.get('/recycle-bin', requirePermission(MODULE, 'view'), async (_req, res) => {
  const rows = await prisma.purchaseOrder.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: 'desc' },
    take: 200,
    include: {
      supplier: { select: { id: true, name: true, code: true } },
      lines: { select: { id: true } },
    },
  })

  // Resolved in one query rather than through a relation, which would have put
  // a back-reference on User that nothing else wants.
  const ids = [...new Set(rows.map((r) => r.deletedById).filter(Boolean))] as string[]
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  })
  const nameById = new Map(users.map((u) => [u.id, u.name]))

  res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      poNumber: r.poNumber,
      poDate: r.poDate,
      status: r.status,
      totalAmount: r.totalAmount,
      lineCount: r.lines.length,
      supplier: r.supplier,
      deletedAt: r.deletedAt,
      deletedBy: r.deletedById ? (nameById.get(r.deletedById) ?? 'Someone since removed') : null,
    })),
  })
})

/** Puts one back, exactly as it was. */
router.post(
  '/recycle-bin/:id/restore',
  requirePermission(MODULE, 'delete'),
  async (req: AuthRequest, res) => {
    const order = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } })
    if (!order || !order.deletedAt) {
      throw new AppError('That order is not in the recycle bin', 404, 'NOT_IN_BIN')
    }

    const after = await prisma.purchaseOrder.update({
      where: { id: order.id },
      data: { deletedAt: null, deletedById: null },
    })

    // And an order put back stands on it again.
    if (order.enquiryId) await syncEnquiryStatus(prisma, order.enquiryId)

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'PurchaseOrder',
      entityId: order.id,
      before: order,
      after,
    })

    res.json({ success: true, message: `${order.poNumber} restored.` })
  }
)

/**
 * Empties one order out of the bin for good.
 *
 * This is the only route in the module that actually removes a purchase order.
 * The lines, charges and attachment rows cascade; the attachment files are
 * swept up after, best effort, because a file with no row is invisible and
 * merely wastes space while a row pointing at a missing file is a broken
 * download.
 *
 * The guards are checked again rather than trusted from when it was binned: an
 * order can sit in the bin while a goods receipt is written against it by
 * someone who never opened the bin, and there is no undoing this one.
 */
router.delete(
  '/recycle-bin/:id',
  requirePermission(MODULE, 'delete'),
  async (req: AuthRequest, res) => {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: {
        ...poInclude,
        attachments: true,
        _count: { select: { grns: true, invoices: true } },
      },
    })
    if (!order || !order.deletedAt) {
      throw new AppError('That order is not in the recycle bin', 404, 'NOT_IN_BIN')
    }
    if (order._count.grns > 0 || order._count.invoices > 0) {
      throw new AppError(
        `${order.poNumber} has stock or bills against it now, so it cannot be destroyed. Restore it instead.`,
        409,
        'PO_HAS_DOCUMENTS'
      )
    }

    await writeAuditLog(req, {
      module: MODULE,
      action: 'DELETE',
      entityType: 'PurchaseOrder',
      entityId: order.id,
      before: order,
    })

    await prisma.purchaseOrder.delete({ where: { id: order.id } })

    for (const file of order.attachments ?? []) {
      await removeObject(file.storagePath).catch(() => {})
    }

    res.json({ success: true, message: `${order.poNumber} destroyed.` })
  }
)

// ── Files kept against an order ─────────────────────────────────────────────
//
// Three steps, because the bytes never pass through here: ask for a link, send
// the file straight to storage, then tell us it landed so the row can be
// written. See lib/storage.ts for why.

const attachmentInclude = {
  uploadedBy: { select: { id: true, name: true } },
}

router.get('/orders/:id/attachments', requirePermission(MODULE, 'view'), async (req, res) => {
  const rows = await prisma.purchaseOrderAttachment.findMany({
    where: { poId: req.params.id },
    include: attachmentInclude,
    orderBy: { createdAt: 'asc' },
  })
  res.json({ success: true, data: rows })
})

/** Step one: a one-use link to send the file to. Nothing is recorded yet. */
router.post(
  '/orders/:id/attachments/upload-url',
  requirePermission(MODULE, 'edit'),
  async (req, res) => {
    const { fileName, sizeBytes } = z
      .object({
        fileName: z.string().min(1, 'The file needs a name').max(255),
        sizeBytes: z
          .number()
          .int()
          .positive('That file is empty')
          .max(MAX_FILE_BYTES, `Files have to be ${MAX_FILE_BYTES / 1024 / 1024}MB or smaller`),
      })
      .parse(req.body)

    const po = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      select: { id: true, poNumber: true, status: true, deletedAt: true },
    })
    if (!po || po.deletedAt) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')

    // Checked before the link is handed out rather than after the file has
    // been sent, so nobody waits for an upload that was never going to count.
    const already = await prisma.purchaseOrderAttachment.count({ where: { poId: po.id } })
    if (already >= MAX_FILES_PER_DOCUMENT) {
      throw new AppError(
        `${po.poNumber} already has ${MAX_FILES_PER_DOCUMENT} files. Remove one before adding another.`,
        409,
        'TOO_MANY_FILES'
      )
    }

    const path = storagePathFor('purchase-orders', po.id, fileName)
    const { uploadUrl } = await signedUploadUrl(path)

    res.json({ success: true, data: { uploadUrl, storagePath: path, fileName, sizeBytes } })
  }
)

/** Step three: the file is in the bucket, so record it. */
router.post(
  '/orders/:id/attachments',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { fileName, storagePath } = z
      .object({
        fileName: z.string().min(1).max(255),
        storagePath: z.string().min(1),
      })
      .parse(req.body)

    const po = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      select: { id: true, poNumber: true, deletedAt: true },
    })
    if (!po || po.deletedAt) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')

    // A path is only ever handed out for one order, and this is what stops a
    // reply being replayed against another one.
    if (!storagePath.startsWith(`purchase-orders/${po.id}/`)) {
      throw new AppError('That file does not belong to this order', 400, 'WRONG_DOCUMENT')
    }

    // The browser told us the size. Ask storage instead — the row must describe
    // a file that is really there, at the size it really is.
    const { sizeBytes, mimeType } = await statObject(storagePath)
    if (sizeBytes > MAX_FILE_BYTES) {
      await removeObject(storagePath).catch(() => {})
      throw new AppError(
        `That file is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024}MB.`,
        400,
        'FILE_TOO_LARGE'
      )
    }

    const attachment = await prisma.purchaseOrderAttachment.create({
      data: {
        poId: po.id,
        fileName,
        storagePath,
        mimeType,
        sizeBytes,
        uploadedById: req.user!.id,
      },
      include: attachmentInclude,
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'CREATE',
      entityType: 'PurchaseOrderAttachment',
      entityId: attachment.id,
      after: attachment,
    })

    res.status(201).json({ success: true, data: attachment })
  }
)

/** A link that works for a few minutes. The bucket itself stays private. */
router.get('/attachments/:id/link', requirePermission(MODULE, 'view'), async (req, res) => {
  const file = await prisma.purchaseOrderAttachment.findUnique({ where: { id: req.params.id } })
  if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')

  res.json({
    success: true,
    data: { url: await signedDownloadUrl(file.storagePath), fileName: file.fileName },
  })
})

router.delete(
  '/attachments/:id',
  requirePermission(MODULE, 'delete'),
  async (req: AuthRequest, res) => {
    const file = await prisma.purchaseOrderAttachment.findUnique({
      where: { id: req.params.id },
      include: attachmentInclude,
    })
    if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')

    // The row goes first. A row pointing at a file that is gone is a broken
    // download; a file with no row is invisible and merely wastes space.
    await prisma.purchaseOrderAttachment.delete({ where: { id: file.id } })
    await removeObject(file.storagePath).catch(() => {})

    await writeAuditLog(req, {
      module: MODULE,
      action: 'DELETE',
      entityType: 'PurchaseOrderAttachment',
      entityId: file.id,
      before: file,
    })

    res.json({ success: true, message: `${file.fileName} removed.` })
  }
)

// ── Goods receipt ───────────────────────────────────────────────────────────
//
// The inward document. Until this existed, stock could only arrive through an
// opening balance or a correction, and an order stayed open forever because
// nothing ever told it the goods had turned up.
//
// Receiving is one act, not a draft confirmed later. The lorry is at the gate,
// the rolls are counted, and saving is what puts them on the rack — so the
// receipt is written and the stock moves inside one transaction, and the
// document cannot be edited afterwards. A mistake is cancelled and re-entered.

/** Quantities are stored to three decimals; fabric is received in metres. */
const round3 = (n: number) => Math.round(n * 1000) / 1000

const grnInclude = {
  po: {
    select: {
      id: true,
      poNumber: true,
      poDate: true,
      status: true,
      supplier: { select: { id: true, name: true, code: true } },
    },
  },
  createdBy: { select: { id: true, name: true } },
  // A count, not the rows — the list only needs to say whether a receipt has
  // paperwork attached, and the dialog that shows the files fetches them
  // itself when it opens.
  _count: { select: { attachments: true } },
  lines: {
    include: {
      item: {
        select: { id: true, code: true, name: true, hsnCode: true, uom: { select: { symbol: true } } },
      },
      warehouse: { select: { id: true, name: true } },
      // What has already been claimed against each receipt line, so the list
      // can say which receipts are still waiting on a supplier's bill. A
      // cancelled bill claims nothing, so it is filtered out of the sum rather
      // than left to make a receipt look settled.
      billLines: {
        where: { bill: { status: { not: 'CANCELLED' as const } } },
        select: { id: true, qty: true, bill: { select: { id: true, billNumber: true } } },
      },
    },
  },
}

/**
 * Whether a receipt still needs a bill raising against it.
 *
 * Counted from what **arrived**, not what was accepted: the supplier's tax
 * invoice travels with the truck and is written for the whole delivery
 * before anyone at the gate has counted a reject out of it, so the bill that
 * has to match that invoice number and total is for the same figure — the
 * mill pays for goods it is disputing and claims the difference back on a
 * debit note, rather than never billing for them at all. `acceptedQty` is
 * kept alongside it, unchanged, for the screens that still want to say how
 * much of a receipt actually reached the rack.
 */
function billingStateOf(grn: {
  lines: Array<{
    acceptedQty: Prisma.Decimal | number | string
    receivedQty: Prisma.Decimal | number | string
    billLines: Array<{ qty: Prisma.Decimal | number | string }>
  }>
}) {
  let accepted = 0
  let received = 0
  let billed = 0

  for (const line of grn.lines) {
    accepted += Number(line.acceptedQty)
    received += Number(line.receivedQty)
    for (const bl of line.billLines) billed += Number(bl.qty)
  }

  return {
    acceptedQty: round3(accepted),
    receivedQty: round3(received),
    billedQty: round3(billed),
    pendingQty: round3(Math.max(0, received - billed)),
    status:
      received <= 0 ? 'NOTHING_TO_BILL' : billed <= 0 ? 'NOT_BILLED' : billed >= received ? 'BILLED' : 'PARTLY_BILLED',
  }
}

/**
 * Refuses to take a receipt away from under a document built on it.
 *
 * For cancelling and deleting only. Neither can be made safe by checking
 * quantities, because both remove the whole receipt at once and every bill
 * and note standing on it is left pointing at a document that no longer
 * records the goods arriving. Cancel had no check of any kind: a receipt
 * billed in full and paid in full could be cancelled, the stock pulled back
 * off the rack, and nothing anywhere saying the supplier had been paid for
 * goods the ledger no longer showed. Delete was held only by a foreign key
 * refusing, which does stop it, but arrives as a database error rather than
 * as a sentence.
 *
 * Correcting is a different question and is deliberately not asked here — it
 * is allowed wherever it leaves every posted document still true, which the
 * line-by-line guards in the edit route test directly. Blanket-refusing a
 * correction made a part-billed receipt unfixable without cancelling a
 * perfectly good bill, and that is how corrections stop being made at all.
 *
 * A paid bill cannot itself be cancelled until the payment is reversed, so a
 * paid bill locks its receipt against cancelling and deleting. That is
 * deliberate, and the message says so rather than leaving somebody to
 * discover it one refusal later.
 */
async function refuseIfClaimed(
  tx: Prisma.TransactionClient,
  grn: { id: string; grnNumber: string },
  what: 'cancelled' | 'deleted'
) {
  const claims = await tx.purchaseInvoiceLine.findMany({
    where: { grnLine: { grnId: grn.id }, bill: { status: { not: 'CANCELLED' } } },
    select: { bill: { select: { billNumber: true, status: true } } },
  })

  if (claims.length) {
    const bills = [...new Map(claims.map((c) => [c.bill.billNumber, c.bill])).values()]
    const named = bills.map((b) => b.billNumber).join(' and ')
    const settled = bills.filter((b) => b.status === 'PAID' || b.status === 'PARTIAL')
    const many = bills.length > 1

    throw new AppError(
      settled.length
        ? `${grn.grnNumber} is billed on ${named}, and ${settled.length > 1 ? 'those bills have' : 'that bill has'} been paid. Reverse the payment and cancel ${many ? 'those bills' : 'that bill'} before this receipt can be ${what}.`
        : `${grn.grnNumber} cannot be ${what} — it is already billed on ${named}. Cancel ${many ? 'those bills' : 'that bill'} first, then put the receipt right and bill it again.`,
      409,
      'GRN_BILLED'
    )
  }

  /*
   * A note can hold a receipt without any bill being involved.
   *
   * A debit note raised straight off the rejected quantity names the receipt
   * line it came from, and `PurchaseNoteLine.grnLineId` is `Restrict` for the
   * same reason the bill's is — a posted adjustment pointing at nothing is a
   * quantity claimable all over again. The bill check above would not have
   * seen it, so deleting such a receipt reached the database and came back as
   * a constraint error, and correcting or cancelling one was not stopped at
   * all.
   */
  const notes = await tx.purchaseNote.findMany({
    where: {
      status: { not: 'CANCELLED' },
      OR: [{ grnId: grn.id }, { lines: { some: { grnLine: { grnId: grn.id } } } }],
    },
    select: { noteNumber: true, status: true },
  })
  if (!notes.length) return

  const posted = notes.filter((n) => n.status === 'POSTED')
  const relevant = posted.length ? posted : notes
  const named = relevant.map((n) => n.noteNumber).join(' and ')
  const many = relevant.length > 1

  throw new AppError(
    posted.length
      ? `${grn.grnNumber} cannot be ${what} — ${named} ${many ? 'have' : 'has'} been posted against it, so ${many ? 'their' : 'its'} quantity has already been claimed back. Cancel ${many ? 'those notes' : 'that note'} first.`
      : `${grn.grnNumber} cannot be ${what} — ${named} ${many ? 'are' : 'is'} raised against it. Cancel ${many ? 'those notes' : 'that note'} first.`,
    409,
    'GRN_NOTED'
  )
}

/**
 * Refuses to change or cancel a bill that a note is already built on.
 *
 * A posted note has done two things that cannot be quietly undone from the
 * bill's side: it has taken its value off what the supplier is owed, and
 * where it named a godown it has taken the goods off the rack. Editing the
 * bill underneath it replaces every bill line wholesale, which the note's own
 * `billLineId` refuses at the database; cancelling the bill was not checked at
 * all, and left the note adjusting a document that no longer exists.
 *
 * A note that is still a draft is refused too. It has changed nothing yet, but
 * it is pinned to the bill lines this edit would replace, and a note left
 * pointing at a bill that was cancelled underneath it can never be posted or
 * put right. Cancelling a draft note costs two clicks; the message says so.
 */
async function refuseIfNoted(
  tx: Prisma.TransactionClient,
  bill: { id: string; billNumber: string },
  what: 'corrected' | 'cancelled'
) {
  const notes = await tx.purchaseNote.findMany({
    where: { billId: bill.id, status: { not: 'CANCELLED' } },
    select: { noteNumber: true, status: true },
  })
  if (!notes.length) return

  const posted = notes.filter((n) => n.status === 'POSTED')
  const relevant = posted.length ? posted : notes
  const named = relevant.map((n) => n.noteNumber).join(' and ')
  const many = relevant.length > 1

  throw new AppError(
    posted.length
      ? `${bill.billNumber} cannot be ${what} — ${named} ${many ? 'have' : 'has'} been posted against it, so ${many ? 'their' : 'its'} value is already off what the supplier is owed and any goods on ${many ? 'them' : 'it'} have left the store. Cancel ${many ? 'those notes' : 'that note'} first.`
      : `${bill.billNumber} cannot be ${what} — ${named} ${many ? 'are' : 'is'} raised against it. Cancel ${many ? 'those notes' : 'that note'} first.`,
    409,
    'BILL_HAS_NOTES'
  )
}

/**
 * How much of each order line has actually arrived, counted from the
 * receipts themselves rather than from a running total on the order.
 *
 * Summed from `receivedQty` — the whole delivery, rejects included — not
 * from `acceptedQty`. A reject is still a dispute over goods that turned up,
 * not goods the supplier still owes: the order does not stay open waiting
 * for a replacement that was never promised, and the line's own "still due"
 * is worked out against what showed up at the gate, the same figure the
 * bill it is settled against is capped by. What was actually taken into
 * stock is a different question, answered by `acceptedQty` on the receipt
 * line itself wherever stock is the thing being moved.
 *
 * The stored `receivedQty` is a convenience for the order screen; this is the
 * figure every decision is made against, for the same reason a stock balance is
 * summed from its movements — a total somebody keeps updating is a total that
 * can drift away from the documents underneath it.
 *
 * A cancelled receipt is left out, which is what lets a cancellation give the
 * quantity back to the order.
 */
async function receivedByPoLine(
  tx: Prisma.TransactionClient,
  poLineIds: string[]
): Promise<Map<string, number>> {
  if (poLineIds.length === 0) return new Map()

  const sums = await tx.gRNLine.groupBy({
    by: ['poLineId'],
    where: { poLineId: { in: poLineIds }, grn: { status: { not: 'CANCELLED' } } },
    _sum: { receivedQty: true },
  })

  return new Map(sums.map((s) => [s.poLineId as string, Number(s._sum.receivedQty ?? 0)]))
}

/**
 * How much of each order line has been rejected on the receipts against it.
 *
 * Rejected stock never becomes `PurchaseOrderLine.receivedQty` — that field
 * only ever counts what was accepted — so a line that came in full but with
 * half of it refused otherwise shows no trace of the refusal anywhere an
 * order is looked at. This is what lets a screen say so.
 */
async function rejectedByPoLine(
  tx: Prisma.TransactionClient,
  poLineIds: string[]
): Promise<Map<string, number>> {
  if (poLineIds.length === 0) return new Map()

  const sums = await tx.gRNLine.groupBy({
    by: ['poLineId'],
    where: { poLineId: { in: poLineIds }, grn: { status: { not: 'CANCELLED' } } },
    _sum: { rejectedQty: true },
  })

  return new Map(sums.map((s) => [s.poLineId as string, Number(s._sum.rejectedQty ?? 0)]))
}

/** The one order line a receipt line is booking against. */
interface BookablePoLine {
  id: string
  itemId: string
  qty: Prisma.Decimal | number | string
  unitRate: Prisma.Decimal | number | string
  shortClosed: boolean
  item: { name: string }
}

interface GrnLineInput {
  poLineId: string
  warehouseId: string
  receivedQty: number
  rejectedQty?: number
  batchNumber?: string | null
}

/**
 * Checks a receipt's lines against the order they book against, and works out
 * what each one will actually put into stock.
 *
 * Shared between raising a receipt and correcting one already on the books —
 * both are "here is what this receipt now says", and the checks (a line still
 * on the order, and not closed short) apply exactly the same either way.
 * `already` is the order's own running total *excluding this receipt's own
 * current lines* — the caller works that out, because only it knows whether
 * there is a "this receipt" to exclude.
 *
 * **There is no limit on how much a receipt may book in.** A delivery can be
 * short or over by any amount and it saves without being questioned: fabric
 * comes in the lengths the mill sends, and a lorry at the gate is not the
 * place to argue about it. An allowance of a few per cent was tried and
 * removed — it only taught the store keeper to type a number the scale did
 * not show. The order's own quantity is still what the bill is matched
 * against, so nothing is paid for twice.
 */
function prepareGrnLines(
  poLines: Map<string, BookablePoLine>,
  already: Map<string, number>,
  lines: GrnLineInput[]
) {
  const bookingByPoLine = new Map<string, number>()
  for (const line of lines) {
    const accepted = round3(round3(line.receivedQty) - round3(line.rejectedQty ?? 0))
    bookingByPoLine.set(line.poLineId, round3((bookingByPoLine.get(line.poLineId) ?? 0) + accepted))
  }

  const prepared = lines.map((line) => {
    const poLine = poLines.get(line.poLineId)
    if (!poLine) {
      throw new AppError('One of those lines is not on this order. Reopen it and try again.', 400, 'LINE_NOT_ON_ORDER')
    }

    if (poLine.shortClosed) {
      throw new AppError(
        `${poLine.item.name} was closed short — reopen that line on the order before receiving more against it.`,
        400,
        'LINE_SHORT_CLOSED'
      )
    }

    /*
     * Everything that arrives is taken into stock.
     *
     * The gate used to be able to refuse part of a delivery, and what reached
     * the rack was `received − rejected`. That put the argument about quality
     * in two places at once: a rejected quantity on the receipt, and then a
     * debit note against the bill for the same goods, with nothing stopping
     * somebody doing both and taking the stock down twice.
     *
     * Now the receipt answers one question — what came off the lorry — and
     * anything wrong with it is settled afterwards on a debit note, where the
     * quantity and the money move together.
     *
     * `rejectedQty` is still read off the wire and pinned to zero rather than
     * rejected outright, so a receipt from an older client still books.
     */
    const received = round3(line.receivedQty)
    const rejected = 0
    const accepted = received
    const ordered = Number(poLine.qty)

    return {
      poLine,
      warehouseId: line.warehouseId,
      batchNumber: line.batchNumber ?? null,
      orderedQty: ordered,
      received,
      rejected,
      accepted,
      unitRate: Number(poLine.unitRate),
    }
  })

  return { prepared }
}

/** Refuses a store that does not exist, or is no longer in use. */
async function assertWarehousesUsable(
  tx: Prisma.TransactionClient,
  warehouseIds: string[]
): Promise<void> {
  const warehouses = await tx.warehouse.findMany({
    where: { id: { in: warehouseIds } },
    select: { id: true, name: true, isActive: true },
  })
  if (warehouses.length !== warehouseIds.length) {
    throw new AppError('One of those stores does not exist', 404, 'NOT_FOUND')
  }
  const closed = warehouses.find((w) => !w.isActive)
  if (closed) {
    throw new AppError(
      `${closed.name} is no longer in use. Pick another store for these goods.`,
      400,
      'WAREHOUSE_INACTIVE'
    )
  }
}

/**
 * Puts the order back in step with what has been received.
 *
 * Called after every receipt, every cancellation, and every short-close, so
 * the order's status and its pending quantities are a reading of the receipts
 * rather than a guess made at the time. Rejected goods still count as
 * received: the supplier sent them, and a receipt with a rejection on it is
 * a quality dispute settled with a debit note, not a shortfall the order
 * keeps waiting on. A line ordered at 10 and delivered at 10 — 2 of them
 * refused — is not owed another 2; it is done, and the 2 are the debit
 * note's problem now.
 *
 * A line closed short counts as done here without counting as received: its
 * `pendingQty` is pinned at 0 regardless of the ordered-versus-received
 * arithmetic that decides every other line, and it does not hold the order
 * back from COMPLETED the way an ordinary shortfall would.
 */
async function syncOrderFromReceipts(tx: Prisma.TransactionClient, poId: string) {
  const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } })
  if (!po || po.deletedAt) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')

  const received = await receivedByPoLine(
    tx,
    po.lines.map((l) => l.id)
  )

  let anyReceived = false
  let allComplete = true

  for (const line of po.lines) {
    const got = received.get(line.id) ?? 0
    const ordered = Number(line.qty)

    if (got > 0) anyReceived = true
    if (!line.shortClosed && got < ordered) allComplete = false

    await tx.purchaseOrderLine.update({
      where: { id: line.id },
      data: {
        receivedQty: got,
        pendingQty: line.shortClosed ? 0 : round3(Math.max(0, ordered - got)),
      },
    })
  }

  // A cancelled order stays cancelled. Receiving against one is refused long
  // before this runs, so the only way to be here is the cancellation of an old
  // receipt — and that must not quietly reopen the order.
  const status =
    po.status === 'CANCELLED'
      ? 'CANCELLED'
      : anyReceived
        ? allComplete
          ? 'COMPLETED'
          : 'PARTIALLY_RECEIVED'
        : 'SENT'

  return tx.purchaseOrder.update({ where: { id: po.id }, data: { status } })
}

router.get('/grn', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

  const where: Prisma.GRNWhereInput = {}
  const poId = text(req.query.poId)
  const status = text(req.query.status)
  const supplierId = text(req.query.supplierId)
  const itemId = text(req.query.itemId)
  const from = text(req.query.from)
  const to = text(req.query.to)
  const q = text(req.query.q)

  if (poId) where.poId = poId
  if (status) where.status = status as Prisma.GRNWhereInput['status']
  // Through the order, because a receipt has no supplier of its own — it is
  // whoever the order was placed with.
  if (supplierId) where.po = { supplierId }
  // `some`, not `every`: a receipt of four things is still a receipt of the
  // thread, and whoever asks where the thread came in wants it listed.
  if (itemId) where.lines = { some: { itemId } }

  /*
   * A day range, inclusive at both ends.
   *
   * `to` is pushed to the end of its day. A receipt booked at four in the
   * afternoon on the 19th belongs to the 19th, and a range ending on the 19th
   * that left it out would be a filter quietly losing the day you asked for.
   */
  if (from || to) {
    const range: Prisma.DateTimeFilter = {}
    if (from) range.gte = new Date(`${from}T00:00:00`)
    if (to) range.lte = new Date(`${to}T23:59:59.999`)
    where.grnDate = range
  }
  if (q) {
    where.OR = [
      { grnNumber: { contains: q, mode: 'insensitive' } },
      { po: { poNumber: { contains: q, mode: 'insensitive' } } },
      { po: { supplier: { name: { contains: q, mode: 'insensitive' } } } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.gRN.findMany({
      where,
      include: grnInclude,
      orderBy: [{ grnDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.gRN.count({ where }),
  ])

  res.json({
    success: true,
    // Billing state is worked out here rather than on the screen, so the list
    // and the bill form cannot come to different conclusions about what is
    // still owed against a receipt.
    data: rows.map((grn) => ({
      ...grn,
      billing: billingStateOf(grn),
      bills: [
        ...new Map(
          grn.lines.flatMap((l) => l.billLines.map((bl) => bl.bill)).map((b) => [b.id, b])
        ).values(),
      ],
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

/**
 * Everything the printed note needs, in one call.
 *
 * The figures are worked out here rather than on the sheet. A printed document
 * that does its own arithmetic is a second implementation of the arithmetic,
 * and the two drift — the sheet is for laying out numbers, not deciding them.
 *
 * What it values is what was **accepted**, at the order's rate. Rejected goods
 * are on the note as a quantity so the driver and the store keeper can see
 * them, but they are worth nothing: they never entered stock and they are not
 * going to be paid for.
 */
/**
 * The names the receipts screen's two filters can offer.
 *
 * Asked for once, separately from the list, because the list is paged and the
 * filters are not. The screen used to build these from the rows it happened to
 * have in front of it, which made "All suppliers" mean "every supplier on this
 * page" — so a receipt from page four could not be filtered to without paging
 * to it first, and there was nothing on screen to say so.
 *
 * Only what is actually on a receipt. The item master has hundreds of rows and
 * most of them have never arrived from anybody; a filter listing all of them is
 * something to scroll, not something to filter with. The screen unions this
 * with the suppliers and items on orders still awaiting goods, which it already
 * holds in full.
 *
 * Registered above `/grn/:id` so that route does not swallow it.
 */
router.get('/grn/filter-options', requirePermission(MODULE, 'view'), async (_req, res) => {
  const [suppliers, items] = await Promise.all([
    prisma.supplier.findMany({
      where: { purchaseOrders: { some: { grns: { some: {} } } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.item.findMany({
      where: { grnLines: { some: {} } },
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])

  res.json({ success: true, data: { suppliers, items } })
})

router.get('/grn/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const grn = await prisma.gRN.findUnique({
    where: { id: req.params.id },
    include: {
      createdBy: { select: { id: true, name: true } },
      po: {
        include: {
          supplier: true,
          deliveryWarehouse: { select: { id: true, name: true } },
        },
      },
      lines: {
        include: {
          item: {
            select: {
              id: true,
              code: true,
              name: true,
              hsnCode: true,
              uom: { select: { symbol: true } },
            },
          },
          warehouse: { select: { id: true, name: true } },
          poLine: {
            select: { id: true, discount: true, gstRate: true, hsnCode: true, description: true },
          },
        },
      },
    },
  })
  if (!grn) throw new AppError('That goods receipt does not exist', 404, 'NOT_FOUND')

  const header = await getPrintHeader('GRN')

  /*
   * The order decides the tax split, not this receipt.
   *
   * Which of IGST or CGST+SGST applies was settled when the order was raised —
   * it follows the place of supply — and a receipt cannot change it. Read off
   * the order's own figures rather than worked out again, so the note and the
   * order can never disagree about what kind of tax this is.
   */
  const taxMode = Number(grn.po.igst) > 0 ? 'IGST' : Number(grn.po.cgst) > 0 ? 'CGST_SGST' : 'NONE'

  const lines = grn.lines.map((l) => {
    const accepted = Number(l.acceptedQty)
    const rate = Number(l.unitRate)
    const discountPct = Number(l.poLine?.discount ?? 0)
    const gstPct = taxMode === 'NONE' ? 0 : Number(l.poLine?.gstRate ?? 0)

    const gross = accepted * rate
    const discount = gross * (discountPct / 100)
    const taxable = gross - discount

    return {
      ...l,
      discountPct,
      gstPct,
      gross: round2(gross),
      discountAmount: round2(discount),
      taxable: round2(taxable),
      tax: round2(taxable * (gstPct / 100)),
    }
  })

  const subtotal = round2(lines.reduce((sum, l) => sum + l.gross, 0))
  const discount = round2(lines.reduce((sum, l) => sum + l.discountAmount, 0))
  const taxable = round2(lines.reduce((sum, l) => sum + l.taxable, 0))
  const tax = round2(lines.reduce((sum, l) => sum + l.tax, 0))

  /*
   * Rounded to the rupee, as an Indian document is settled, and the difference
   * is shown. Without that row the figures above add up to something else and
   * nothing on the paper says why.
   */
  const beforeRound = taxable + tax
  const total = Math.round(beforeRound)

  res.json({
    success: true,
    data: {
      ...header,
      grn: { ...grn, lines },
      totals: {
        subtotal,
        discount,
        taxable,
        cgst: taxMode === 'CGST_SGST' ? round2(tax / 2) : 0,
        sgst: taxMode === 'CGST_SGST' ? round2(tax / 2) : 0,
        igst: taxMode === 'IGST' ? tax : 0,
        tax,
        roundOff: round2(total - beforeRound),
        total,
        rejectedQty: lines.reduce((sum, l) => sum + Number(l.rejectedQty), 0),
      },
      totalInWords: amountInWords(total),
      taxMode,
    },
  })
})

router.get('/grn/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  /*
   * The edit screen needs more than the receipt itself: the order's own
   * lines (an item this receipt never touched can still be added), and how
   * much of each line other receipts already account for — the "still due"
   * a correction is checked against has to leave this receipt's own current
   * lines out of that arithmetic, the same as saving the correction does.
   *
   * It also needs far LESS of the receipt, which is what this branch exists
   * for. `grnInclude` pulls each line's item, its unit, its warehouse and
   * every bill line claiming it, and Prisma fetches a relation per round
   * trip — about six of them. The edit dialog reads none of it: its lines
   * carry four scalars, and every name on the screen comes off the order,
   * which is fetched in full just below. Against the mill's database one
   * round trip is roughly 300ms, so that include was 1,257ms of a 2,587ms
   * request. Asked for what the screen actually reads it comes back in 389ms
   * and the whole request in about 1.6s.
   *
   * `include`, not `select`, on purpose — every column of the receipt itself
   * still arrives, so a field added to the header later cannot go missing
   * from the correction form. Only the lines are narrowed, and they are the
   * part that was heavy.
   *
   * Sequential, and deliberately so: the two reads were tried in parallel
   * and came back no faster, because the pooler in front of this database
   * serialises them anyway.
   */
  if (req.query.view === 'editing') {
    const grn = await prisma.gRN.findUnique({
      where: { id: req.params.id },
      include: {
        lines: {
          select: {
            id: true,
            poLineId: true,
            warehouseId: true,
            receivedQty: true,
            rejectedQty: true,
          },
        },
      },
    })
    if (!grn) throw new AppError('That goods receipt does not exist', 404, 'NOT_FOUND')

    const po = await prisma.purchaseOrder.findUnique({
      where: { id: grn.poId },
      include: poReceivingInclude,
    })
    const receivedElsewhere = await receivedByPoLine(
      prisma,
      (po?.lines ?? []).map((l) => l.id)
    )
    for (const line of grn.lines) {
      if (!line.poLineId) continue
      receivedElsewhere.set(
        line.poLineId,
        round3((receivedElsewhere.get(line.poLineId) ?? 0) - Number(line.receivedQty))
      )
    }
    res.json({
      success: true,
      data: { ...grn, po, otherReceived: Object.fromEntries(receivedElsewhere) },
    })
    return
  }

  const grn = await prisma.gRN.findUnique({ where: { id: req.params.id }, include: grnInclude })
  if (!grn) throw new AppError('That goods receipt does not exist', 404, 'NOT_FOUND')

  res.json({ success: true, data: grn })
})

/**
 * Booking goods in against an order.
 *
 * Everything happens in one transaction: the number, the receipt, the stock and
 * the order's new state. A receipt saved without its stock, or stock in without
 * its receipt, is exactly the half-truth that makes a stock figure impossible
 * to defend six months later.
 */
router.post('/grn', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createGrnSchema.parse(req.body)
  const when = data.grnDate ?? new Date()

  const grn = await prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: data.poId },
      include: {
        lines: { include: { item: { select: { name: true } } } },
        deliveryWarehouse: { select: { id: true, name: true, address: true } },
      },
    })
    if (!po || po.deletedAt)
      throw new AppError('That purchase order does not exist', 404, 'NOT_FOUND')

    if (po.status === 'DRAFT') {
      throw new AppError(
        `${po.poNumber} has not been sent to the supplier yet. Send it first, then receive against it.`,
        400,
        'PO_NOT_SENT'
      )
    }
    if (po.status === 'CANCELLED') {
      throw new AppError(
        `${po.poNumber} was cancelled, so nothing can be received against it.`,
        400,
        'PO_CANCELLED'
      )
    }
    if (po.status === 'COMPLETED') {
      throw new AppError(
        `${po.poNumber} is complete — everything on it has either been received or closed short. Reopen a line first if more is expected.`,
        400,
        'PO_DONE'
      )
    }

    const poLines = new Map(po.lines.map((l) => [l.id, l]))
    const already = await receivedByPoLine(
      tx,
      po.lines.map((l) => l.id)
    )

    const { prepared } = prepareGrnLines(poLines, already, data.lines)

    await assertWarehousesUsable(tx, [...new Set(prepared.map((p) => p.warehouseId))])

    const grnNumber = await nextDocumentNumber(tx, 'GRN', when)

    /*
     * The address this delivery's own paperwork is checked against.
     *
     * The order's own address by default — that is where it was ordered
     * from and is right most of the time. Only recomputed when this receipt
     * names a different one of the supplier's addresses, the same helper and
     * the same validation the order itself uses: an id that does not belong
     * to this supplier is refused rather than silently printing somebody
     * else's premises on the receipt.
     */
    const supplierAddress = data.supplierAddressId
      ? await supplierBillingAddress(tx, po.supplierId, data.supplierAddressId)
      : (po.supplierAddress ?? null)

    const shippingAddress = data.shippingWarehouseId
      ? await shippingAddressFor(tx, data.shippingWarehouseId)
      : (po.deliveryWarehouse?.address ?? null)

    const created = await tx.gRN.create({
      data: {
        grnNumber,
        poId: po.id,
        grnDate: when,
        vehicleNo: data.vehicleNo ?? null,
        supplierAddress,
        shippingAddress,
        // The goods are on the rack the moment this saves. Any other status
        // would be a receipt claiming stock the ledger does not have.
        status: 'ACCEPTED',
        notes: data.notes ?? null,
        // Nothing forces this any more. It is kept because a store keeper who
        // wants to note why a delivery ran over should have somewhere to put
        // it — not because anybody is stopped until they do.
        overReceiptReason: data.overReceiptReason?.trim() || null,

        // The delivery's own paperwork, exactly as it was handed over.
        gateEntryNo: data.gateEntryNo ?? null,
        gateEntryDate: data.gateEntryDate ?? null,
        challanNo: data.challanNo ?? null,
        challanDate: data.challanDate ?? null,
        supplierBillNo: data.supplierBillNo ?? null,
        supplierInvoiceNo: data.supplierInvoiceNo ?? null,
        supplierInvoiceDate: data.supplierInvoiceDate ?? null,
        packageCount: data.packageCount ?? null,
        driverName: data.driverName ?? null,
        formNo: data.formNo ?? null,
        clientName: data.clientName ?? null,
        orderedBy: data.orderedBy ?? null,
        referenceNo: data.referenceNo ?? null,

        // Prints as "Prepared By" on the note. Taken from the session rather
        // than typed, because a signature line somebody can fill in with
        // anybody's name is not a signature line.
        createdById: req.user?.id ?? null,
        lines: {
          create: prepared.map((p) => ({
            poLineId: p.poLine.id,
            itemId: p.poLine.itemId,
            warehouseId: p.warehouseId,
            orderedQty: p.orderedQty,
            receivedQty: p.received,
            rejectedQty: p.rejected,
            acceptedQty: p.accepted,
            batchNumber: p.batchNumber,
            unitRate: p.unitRate,
            amount: round2(p.accepted * p.unitRate),
          })),
        },
      },
    })

    // Only what was accepted becomes stock. Rejected goods never reach the
    // ledger — they are standing at the gate waiting to go back, and booking
    // them in would put stock on the books that nobody can find.
    for (const p of prepared) {
      if (p.accepted <= 0) continue

      await recordMovement(tx, {
        itemId: p.poLine.itemId,
        warehouseId: p.warehouseId,
        transactionType: 'PURCHASE',
        direction: 'IN',
        qty: p.accepted,
        unitRate: p.unitRate,
        batchNumber: p.batchNumber,
        referenceType: 'GRN',
        referenceId: created.id,
        transactionDate: when,
        notes: `${grnNumber} against ${po.poNumber}`,
      })
    }

    await syncOrderFromReceipts(tx, po.id)

    return tx.gRN.findUniqueOrThrow({ where: { id: created.id }, include: grnInclude })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'GRN',
    entityId: grn.id,
    after: grn,
  })

  const rejected = grn.lines.reduce((sum, l) => sum + Number(l.rejectedQty), 0)

  res.status(201).json({
    success: true,
    message:
      rejected > 0
        ? `${grn.grnNumber} saved. ${rejected} was rejected and has not gone into stock.`
        : `${grn.grnNumber} saved and the stock is in.`,
    data: grn,
  })
})

/**
 * Correcting a receipt already on the books — quantities, stores and all.
 *
 * Every line is replaced outright: the receipt's own current stock movements
 * are reversed first (an OUT for whatever they put IN), the new lines are
 * checked against the order exactly as a fresh receipt would be, and new
 * movements are recorded for them. Reversing first is also the safety check —
 * `recordMovement` refuses to take stock below zero, so correcting a line
 * down is refused outright if that stock has already left the warehouse,
 * and the whole correction rolls back untouched. Nothing here can leave the
 * ledger holding a movement the document no longer explains.
 */
router.patch('/grn/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = updateGrnSchema.parse(req.body)
  const when = data.grnDate ?? new Date()

  const grn = await prisma.$transaction(async (tx) => {
    const before = await tx.gRN.findUnique({
      where: { id: req.params.id },
      include: { lines: true },
    })
    if (!before) throw new AppError('That goods receipt does not exist', 404, 'NOT_FOUND')
    if (before.status === 'CANCELLED') {
      throw new AppError(
        `${before.grnNumber} is cancelled — raise a fresh receipt rather than correcting this one.`,
        400,
        'ALREADY_CANCELLED'
      )
    }
    /*
     * No blanket refusal here, on purpose — see the line-by-line guards
     * further down, which are the whole of the rule for correcting.
     *
     * This route briefly refused any correction to a receipt a bill had
     * touched. That is the right answer for cancelling and deleting and the
     * wrong one here: it made a part-billed receipt unfixable without first
     * cancelling a bill that was perfectly correct, and reversing any payment
     * against it. Correcting is allowed as long as every posted document is
     * still true afterwards, which is exactly what those guards test.
     */
    const po = await tx.purchaseOrder.findUnique({
      where: { id: before.poId },
      include: {
        lines: { include: { item: { select: { name: true } } } },
        deliveryWarehouse: { select: { id: true, name: true, address: true } },
      },
    })
    if (!po || po.deletedAt) {
      throw new AppError('The purchase order this receipt is against no longer exists', 404, 'NOT_FOUND')
    }
    if (po.status === 'CANCELLED') {
      throw new AppError(
        `${po.poNumber} was cancelled — this receipt can no longer be corrected against it.`,
        400,
        'PO_CANCELLED'
      )
    }

    for (const line of before.lines) {
      const accepted = Number(line.acceptedQty)
      if (accepted <= 0) continue
      await recordMovement(tx, {
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        transactionType: 'RETURN',
        direction: 'OUT',
        qty: accepted,
        referenceType: 'GRN_EDITED',
        referenceId: before.id,
        transactionDate: new Date(),
        notes: `${before.grnNumber} corrected: ${data.editReason}`,
      })
    }

    const poLines = new Map(po.lines.map((l) => [l.id, l]))

    // This receipt's own old lines must not count against themselves when
    // the new ones are checked against the order's balance — they are the
    // thing being replaced, not a second delivery on top of it.
    const already = await receivedByPoLine(
      tx,
      po.lines.map((l) => l.id)
    )
    for (const line of before.lines) {
      if (!line.poLineId) continue
      already.set(line.poLineId, round3((already.get(line.poLineId) ?? 0) - Number(line.receivedQty)))
    }

    const { prepared } = prepareGrnLines(poLines, already, data.lines)

    await assertWarehousesUsable(tx, [...new Set(prepared.map((p) => p.warehouseId))])

    const supplierAddress = data.supplierAddressId
      ? await supplierBillingAddress(tx, po.supplierId, data.supplierAddressId)
      : (po.supplierAddress ?? null)
    const shippingAddress = data.shippingWarehouseId
      ? await shippingAddressFor(tx, data.shippingWarehouseId)
      : (po.deliveryWarehouse?.address ?? null)

    /*
     * Diffed rather than replaced outright.
     *
     * This used to delete every line and write fresh ones, which gave each a
     * new id — and a bill line points at a receipt line by id. Under the old
     * set-null foreign key that silently orphaned the bill; under the restrict
     * key it would now refuse the edit outright, which would mean a receipt
     * could not have its vehicle number corrected once it had been billed.
     *
     * So a line still on the receipt keeps its identity and is updated in
     * place. Only a line genuinely gone is deleted, and a line a bill is
     * holding cannot go at all.
     */
    const billed = await billedByGrnLine(
      tx,
      before.lines.map((l) => l.id)
    )

    const oldByKey = new Map(
      before.lines.map((l) => [grnLineKey(l.poLineId, l.warehouseId, l.batchNumber), l])
    )
    const matchedOldIds = new Set<string>()
    const pairs = prepared.map((p) => {
      const old = oldByKey.get(grnLineKey(p.poLine.id, p.warehouseId, p.batchNumber))
      if (old && !matchedOldIds.has(old.id)) {
        matchedOldIds.add(old.id)
        return { prepared: p, old }
      }
      return { prepared: p, old: null }
    })

    /*
     * What a live claim will not allow, line by line.
     *
     * This is the whole of the rule for correcting, and it is deliberately
     * narrower than the rule for cancelling or deleting. The accounting test
     * is not "has anything been billed" — it is "does the correction leave
     * every posted document still true". A receipt billed for 400 of the
     * 1,000 that arrived can have the other 600 fixed without touching that
     * invoice, because nothing on the invoice changes. Refusing it would
     * force a clerk to cancel a correct bill — and, if it had been paid,
     * reverse a correct payment — to repair a typing mistake that has
     * nothing to do with either. That trade is how corrections stop being
     * made at all and the stock ledger quietly drifts instead.
     *
     * So two things are refused, and only these two: taking away a line some
     * document is built on, and cutting a line below what has already been
     * claimed off it. Both would leave a posted document pointing at goods
     * that are no longer recorded as arriving.
     *
     * Cancelling and deleting stay blocked outright, because neither can be
     * made safe this way: they take the whole receipt out from under every
     * bill and note on it at once.
     */
    const noted = await notedQtyByGrnLine(
      tx,
      before.lines.map((l) => l.id)
    )

    for (const line of before.lines) {
      const claim = billed.get(line.id)
      const notedQty = noted.get(line.id) ?? 0
      const claimedQty = Math.max(claim?.qty ?? 0, notedQty)
      if (claimedQty <= 0) continue

      const match = pairs.find((pair) => pair.old?.id === line.id)
      const itemName = poLines.get(line.poLineId ?? '')?.item?.name ?? 'That item'
      // Named by whichever document is actually holding it, so the message
      // points at the thing that has to be dealt with.
      const heldBy = claim?.bills.length
        ? claim.bills.join(' and ')
        : 'a note raised against this receipt'

      if (!match) {
        throw new AppError(
          `${itemName} is on ${heldBy} for ${claimedQty}. Take it off that document before removing it from this receipt.`,
          400,
          'GRN_LINE_BILLED'
        )
      }
      // Compared against what was *delivered*, not what was accepted — a bill
      // is free to claim the rejected part of a delivery too, so correcting
      // the received quantity down is what would leave it over-claimed.
      if (round3(match.prepared.received) < claimedQty) {
        throw new AppError(
          `${itemName} is claimed at ${claimedQty} on ${heldBy}, so this receipt cannot be corrected down to ${round3(match.prepared.received)} received. Put that document right first.`,
          400,
          'GRN_BELOW_BILLED'
        )
      }
    }

    const goneIds = before.lines.filter((l) => !matchedOldIds.has(l.id)).map((l) => l.id)
    if (goneIds.length) await tx.gRNLine.deleteMany({ where: { id: { in: goneIds } } })

    for (const { prepared: p, old } of pairs) {
      if (!old) continue
      await tx.gRNLine.update({
        where: { id: old.id },
        data: {
          orderedQty: p.orderedQty,
          receivedQty: p.received,
          rejectedQty: p.rejected,
          acceptedQty: p.accepted,
          unitRate: p.unitRate,
          amount: round2(p.accepted * p.unitRate),
        },
      })
    }

    await tx.gRN.update({
      where: { id: before.id },
      data: {
        grnDate: when,
        vehicleNo: data.vehicleNo ?? null,
        supplierAddress,
        shippingAddress,
        notes: data.notes
          ? `${data.notes}\n(corrected: ${data.editReason})`
          : `(corrected: ${data.editReason})`,
        overReceiptReason: data.overReceiptReason?.trim() || null,
        gateEntryNo: data.gateEntryNo ?? null,
        gateEntryDate: data.gateEntryDate ?? null,
        challanNo: data.challanNo ?? null,
        challanDate: data.challanDate ?? null,
        supplierBillNo: data.supplierBillNo ?? null,
        supplierInvoiceNo: data.supplierInvoiceNo ?? null,
        supplierInvoiceDate: data.supplierInvoiceDate ?? null,
        packageCount: data.packageCount ?? null,
        driverName: data.driverName ?? null,
        formNo: data.formNo ?? null,
        clientName: data.clientName ?? null,
        orderedBy: data.orderedBy ?? null,
        referenceNo: data.referenceNo ?? null,
        lines: {
          create: pairs
            .filter((pair) => !pair.old)
            .map(({ prepared: p }) => ({
            poLineId: p.poLine.id,
            itemId: p.poLine.itemId,
            warehouseId: p.warehouseId,
            orderedQty: p.orderedQty,
            receivedQty: p.received,
            rejectedQty: p.rejected,
            acceptedQty: p.accepted,
            batchNumber: p.batchNumber,
            unitRate: p.unitRate,
            amount: round2(p.accepted * p.unitRate),
          })),
        },
      },
    })

    for (const p of prepared) {
      if (p.accepted <= 0) continue
      await recordMovement(tx, {
        itemId: p.poLine.itemId,
        warehouseId: p.warehouseId,
        transactionType: 'PURCHASE',
        direction: 'IN',
        qty: p.accepted,
        unitRate: p.unitRate,
        batchNumber: p.batchNumber,
        referenceType: 'GRN',
        referenceId: before.id,
        transactionDate: when,
        notes: `${before.grnNumber} against ${po.poNumber} (corrected)`,
      })
    }

    await syncOrderFromReceipts(tx, po.id)

    return tx.gRN.findUniqueOrThrow({ where: { id: before.id }, include: grnInclude })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'GRN',
    entityId: grn.id,
    after: grn,
  })

  res.json({ success: true, message: `${grn.grnNumber} corrected.`, data: grn })
})

/**
 * Removing a receipt for good — not the ordinary undo.
 *
 * Cancelling reverses the stock and keeps the document, which is what a
 * stock audit wants to find later. This is for the receipt that should not
 * exist at all — a duplicate, a test row, an order picked by mistake — and it
 * takes the stock movement with it if one was ever made, the same reversal
 * `recordMovement` enforces everywhere else: if that stock has already left
 * the warehouse, the reversal is refused and nothing is deleted.
 *
 * Refused outright if a purchase bill has been matched against this receipt —
 * the bill's own line still needs something to point at, and the fix there is
 * to unmatch it first, not to have the receipt vanish out from under it.
 */
router.delete('/grn/:id', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const { reason } = deleteGrnSchema.parse(req.body ?? {})

  const before = await prisma.$transaction(async (tx) => {
    const grn = await tx.gRN.findUnique({ where: { id: req.params.id }, include: { lines: true } })
    if (!grn) throw new AppError('That goods receipt does not exist', 404, 'NOT_FOUND')

    // Asked as a question rather than left to the foreign key to answer. The
    // key does refuse — `PurchaseInvoiceLine.grnLineId` is Restrict — but it
    // refuses after the stock has been written back out inside this
    // transaction, and it refuses with a constraint code that has to be
    // recognised and translated. Asking first means the receipt is never
    // unwound in the first place, and the refusal can name the bill.
    await refuseIfClaimed(tx, grn, 'deleted')

    if (grn.status !== 'CANCELLED') {
      for (const line of grn.lines) {
        const accepted = Number(line.acceptedQty)
        if (accepted <= 0) continue
        await recordMovement(tx, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          transactionType: 'RETURN',
          direction: 'OUT',
          qty: accepted,
          referenceType: 'GRN_DELETED',
          referenceId: grn.id,
          transactionDate: new Date(),
          notes: reason ? `${grn.grnNumber} deleted: ${reason}` : `${grn.grnNumber} deleted`,
        })
      }
    }

    try {
      await tx.gRN.delete({ where: { id: grn.id } })
    } catch (err) {
      if (err instanceof Error && err.name === 'PrismaClientKnownRequestError') {
        const code = (err as unknown as { code?: string }).code
        if (code === 'P2003') {
          throw new AppError(
            `${grn.grnNumber} has a bill matched against it — remove it from that bill first.`,
            400,
            'GRN_BILLED'
          )
        }
      }
      throw err
    }

    await syncOrderFromReceipts(tx, grn.poId)

    return grn
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'DELETE',
    entityType: 'GRN',
    entityId: before.id,
    before,
  })

  res.json({ success: true, message: `${before.grnNumber} deleted for good.` })
})

// —— Files kept against a receipt ——
//
// The same three-step pattern as a purchase order's own attachments: ask for
// a link, send the file straight to storage, then tell us it landed. Optional
// throughout — a receipt saves with nothing attached, and the challan or the
// supplier's invoice can be scanned in afterwards.

const grnAttachmentInclude = {
  uploadedBy: { select: { id: true, name: true } },
}

router.get('/grn/:id/attachments', requirePermission(MODULE, 'view'), async (req, res) => {
  const rows = await prisma.gRNAttachment.findMany({
    where: { grnId: req.params.id },
    include: grnAttachmentInclude,
    orderBy: { createdAt: 'asc' },
  })
  res.json({ success: true, data: rows })
})

router.post(
  '/grn/:id/attachments/upload-url',
  requirePermission(MODULE, 'edit'),
  async (req, res) => {
    const { fileName, sizeBytes } = z
      .object({
        fileName: z.string().min(1, 'The file needs a name').max(255),
        sizeBytes: z
          .number()
          .int()
          .positive('That file is empty')
          .max(MAX_FILE_BYTES, `Files have to be ${MAX_FILE_BYTES / 1024 / 1024}MB or smaller`),
      })
      .parse(req.body)

    const grn = await prisma.gRN.findUnique({
      where: { id: req.params.id },
      select: { id: true, grnNumber: true },
    })
    if (!grn) throw new AppError('Goods receipt not found', 404, 'NOT_FOUND')

    const already = await prisma.gRNAttachment.count({ where: { grnId: grn.id } })
    if (already >= MAX_FILES_PER_DOCUMENT) {
      throw new AppError(
        `${grn.grnNumber} already has ${MAX_FILES_PER_DOCUMENT} files. Remove one before adding another.`,
        409,
        'TOO_MANY_FILES'
      )
    }

    const path = storagePathFor('grn', grn.id, fileName)
    const { uploadUrl } = await signedUploadUrl(path)

    res.json({ success: true, data: { uploadUrl, storagePath: path, fileName, sizeBytes } })
  }
)

router.post(
  '/grn/:id/attachments',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { fileName, storagePath } = z
      .object({
        fileName: z.string().min(1).max(255),
        storagePath: z.string().min(1),
      })
      .parse(req.body)

    const grn = await prisma.gRN.findUnique({ where: { id: req.params.id }, select: { id: true } })
    if (!grn) throw new AppError('Goods receipt not found', 404, 'NOT_FOUND')

    if (!storagePath.startsWith(`grn/${grn.id}/`)) {
      throw new AppError('That file does not belong to this receipt', 400, 'WRONG_DOCUMENT')
    }

    const { sizeBytes, mimeType } = await statObject(storagePath)
    if (sizeBytes > MAX_FILE_BYTES) {
      await removeObject(storagePath).catch(() => {})
      throw new AppError(
        `That file is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024}MB.`,
        400,
        'FILE_TOO_LARGE'
      )
    }

    const attachment = await prisma.gRNAttachment.create({
      data: {
        grnId: grn.id,
        fileName,
        storagePath,
        mimeType,
        sizeBytes,
        uploadedById: req.user!.id,
      },
      include: grnAttachmentInclude,
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'CREATE',
      entityType: 'GRNAttachment',
      entityId: attachment.id,
      after: attachment,
    })

    res.status(201).json({ success: true, data: attachment })
  }
)

router.get('/grn-attachments/:id/link', requirePermission(MODULE, 'view'), async (req, res) => {
  const file = await prisma.gRNAttachment.findUnique({ where: { id: req.params.id } })
  if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')

  res.json({
    success: true,
    data: { url: await signedDownloadUrl(file.storagePath), fileName: file.fileName },
  })
})

router.delete(
  '/grn-attachments/:id',
  requirePermission(MODULE, 'delete'),
  async (req: AuthRequest, res) => {
    const file = await prisma.gRNAttachment.findUnique({
      where: { id: req.params.id },
      include: grnAttachmentInclude,
    })
    if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')

    await prisma.gRNAttachment.delete({ where: { id: file.id } })
    await removeObject(file.storagePath).catch(() => {})

    await writeAuditLog(req, {
      module: MODULE,
      action: 'DELETE',
      entityType: 'GRNAttachment',
      entityId: file.id,
      before: file,
    })

    res.json({ success: true, message: `${file.fileName} removed.` })
  }
)

/**
 * Cancelling a receipt.
 *
 * Takes the stock back out and gives the quantity back to the order. If any of
 * it has already been issued the stock service refuses and says how much is
 * actually left, which is the right answer — the goods are gone, and pretending
 * otherwise would leave the rack and the book disagreeing.
 */
router.patch(
  '/grn/:id/cancel',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { reason } = cancelGrnSchema.parse(req.body ?? {})

    const after = await prisma.$transaction(async (tx) => {
      const before = await tx.gRN.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!before) throw new AppError('That goods receipt does not exist', 404, 'NOT_FOUND')

      if (before.status === 'CANCELLED') {
        throw new AppError(`${before.grnNumber} is already cancelled.`, 400, 'ALREADY_CANCELLED')
      }
      // Checked before a single movement is written. This route had no billing
      // guard of any kind: a billed, paid receipt could be cancelled here and
      // the stock taken back out from under an invoice the supplier had
      // already been paid for.
      await refuseIfClaimed(tx, before, 'cancelled')

      for (const line of before.lines) {
        const accepted = Number(line.acceptedQty)
        if (accepted <= 0) continue

        await recordMovement(tx, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          transactionType: 'RETURN',
          direction: 'OUT',
          qty: accepted,
          referenceType: 'GRN_CANCELLED',
          referenceId: before.id,
          transactionDate: new Date(),
          notes: `${before.grnNumber} cancelled: ${reason}`,
        })
      }

      const cancelled = await tx.gRN.update({
        where: { id: before.id },
        data: {
          status: 'CANCELLED',
          notes: `${before.notes ? before.notes + '\n' : ''}Cancelled: ${reason}`,
        },
        include: grnInclude,
      })

      await syncOrderFromReceipts(tx, before.poId)

      return cancelled
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'GRN',
      entityId: after.id,
      after,
    })

    res.json({
      success: true,
      message: `${after.grnNumber} cancelled and the stock taken back out.`,
      data: after,
    })
  }
)

// ── Purchase bills ──────────────────────────────────────────────────────────
//
// The supplier's tax invoice, booked into our books. Two numbers live on it and
// they are not interchangeable: `supplierInvoiceNo` is printed on their paper
// and is what a GST officer matches against; `billNumber` is ours and comes
// from the number series.
//
// The point of this document is the three-way match. A bill is only payable for
// goods that were ordered and actually arrived, so every line that names a
// receipt line is checked against what was accepted there.

const billInclude = {
  supplier: {
    select: {
      id: true,
      name: true,
      code: true,
      gstin: true,
      stateCode: true,
      address: true,
      city: true,
      state: true,
      pincode: true,
      phone: true,
      email: true,
      isMsme: true,
      creditDays: true,
    },
  },
  /*
   * The order's own paperwork travels with the bill.
   *
   * A bill is checked against the quotation that was agreed and the challan
   * that came off the lorry, and neither is attached to the bill itself —
   * they live on the order and the receipt. Carrying them here saves opening
   * two more screens to answer one question.
   */
  po: {
    select: {
      id: true,
      poNumber: true,
      attachments: {
        select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
      },
    },
  },
  createdBy: { select: { id: true, name: true } },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      item: {
        select: {
          id: true,
          code: true,
          name: true,
          hsnCode: true,
          uom: { select: { symbol: true } },
        },
      },
      grnLine: {
        select: {
          id: true,
          receivedQty: true,
          acceptedQty: true,
          rejectedQty: true,
          unitRate: true,
          grn: {
            select: {
              id: true,
              grnNumber: true,
              attachments: {
                select: {
                  id: true,
                  fileName: true,
                  mimeType: true,
                  sizeBytes: true,
                  createdAt: true,
                },
              },
            },
          },
        },
      },
    },
  },
  charges: { include: { chargeType: { select: { id: true, name: true } } } },
  /*
   * What has been paid against the bill, and what has been claimed back from
   * the supplier on it.
   *
   * Both belong here rather than on a screen of their own. A bill is only
   * half a story without them — the question anybody actually asks is "what
   * do we still owe on this, and did we dispute any of it".
   */
  payments: {
    orderBy: { paymentDate: 'desc' as const },
    select: {
      id: true,
      paymentNumber: true,
      paymentDate: true,
      amount: true,
      tdsAmount: true,
      mode: true,
      referenceNo: true,
      chequeNo: true,
      chequeDate: true,
      status: true,
      reversedAt: true,
      reversalReason: true,
      createdBy: { select: { id: true, name: true } },
    },
  },
  /*
   * The debit and credit notes raised against this bill.
   *
   * Cancelled and rejected ones are left out: they claim nothing and adjust
   * nothing, and a bill detail listing four notes of which two are void reads
   * as though the supplier is being chased twice.
   */
  adjustments: {
    where: { status: { notIn: ['CANCELLED', 'REJECTED'] } },
    orderBy: { noteDate: 'desc' as const },
    select: {
      id: true,
      noteNumber: true,
      docType: true,
      issuedBy: true,
      gstTreatment: true,
      noteDate: true,
      reason: true,
      reasonNote: true,
      effect: true,
      supplierDocNo: true,
      taxableAmount: true,
      totalAmount: true,
      status: true,
    },
  },
} satisfies Prisma.PurchaseInvoiceInclude

/** One rate, split the way the two state codes say it must be split. */
function taxSplit(taxableValue: number, gstRate: number, isIntraState: boolean) {
  const tax = round2(taxableValue * (gstRate / 100))
  return isIntraState
    ? { cgst: round2(tax / 2), sgst: round2(tax / 2), igst: 0 }
    : { cgst: 0, sgst: 0, igst: tax }
}

/**
 * Prices a bill.
 *
 * Differs from an order in three ways that all cost money if they are missed:
 * charges carry their own GST rate and cannot be folded into the goods value;
 * reverse charge means the tax is ours to pay rather than the supplier's, so it
 * is recorded but never added to what they are paid; and TDS is withheld from
 * the payment while still settling the bill in full.
 */
function priceBill(opts: {
  lines: BillLineInput[]
  charges: BillChargeInput[]
  discountAmount: number
  isIntraState: boolean
  chargeTax: boolean
  isReverseCharge: boolean
  tdsRate: number
}) {
  const { lines, charges, isIntraState, chargeTax, isReverseCharge } = opts

  const lineGross = lines.map((l) => l.qty * l.unitPrice * (1 - (l.discount ?? 0) / 100))
  const subtotal = round2(lineGross.reduce((s, n) => s + n, 0))

  // Discount comes off before tax — see the business rules.
  const discount = round2(Math.min(opts.discountAmount, subtotal))
  const goodsTaxable = round2(subtotal - discount)
  const factor = subtotal > 0 ? goodsTaxable / subtotal : 1

  const pricedLines = lines.map((l, i) => {
    const taxableValue = round2(lineGross[i] * factor)
    const gstRate = chargeTax ? (l.gstRate ?? 0) : 0
    const split = taxSplit(taxableValue, gstRate, isIntraState)
    return {
      taxableValue,
      gstRate,
      ...split,
      amount: round2(taxableValue + split.cgst + split.sgst + split.igst),
    }
  })

  const pricedCharges = charges.map((c) => {
    const amount = round2(c.amount)
    const gstRate = chargeTax ? (c.gstRate ?? 0) : 0
    return { amount, gstRate, ...taxSplit(amount, gstRate, isIntraState) }
  })

  const chargeTotal = round2(pricedCharges.reduce((s, c) => s + c.amount, 0))
  const taxable = round2(goodsTaxable + chargeTotal)

  const sum = (key: 'cgst' | 'sgst' | 'igst') =>
    round2(
      pricedLines.reduce((s, l) => s + l[key], 0) + pricedCharges.reduce((s, c) => s + c[key], 0)
    )

  const cgst = sum('cgst')
  const sgst = sum('sgst')
  const igst = sum('igst')

  // Under reverse charge the supplier's bill carries no tax — we pay it to the
  // government ourselves. Recording it and then adding it to their payment
  // would pay the tax twice.
  const payable = isReverseCharge ? taxable : taxable + cgst + sgst + igst
  const { rounded, roundOff } = applyRoundOff(payable)

  // TDS is worked out on the taxable value, not on the tax.
  const tdsAmount = round2(taxable * (opts.tdsRate / 100))

  return {
    pricedLines,
    pricedCharges,
    subtotal,
    discount,
    taxable,
    cgst,
    sgst,
    igst,
    roundOff,
    total: rounded,
    tdsAmount,
    // The supplier is paid the total less the TDS we withhold, so the bill is
    // settled in full by that smaller payment rather than being left with a
    // stub outstanding against them forever.
    balance: round2(rounded - tdsAmount),
  }
}

/**
 * The three-way match: ordered, received, billed.
 *
 * Refuses a bill for more than physically arrived at the gate — never for
 * more than was *accepted*. A supplier's tax invoice is written for the whole
 * delivery before anyone has counted a reject out of it, and the mill's own
 * books have to carry the same number the invoice does; what QC refused is
 * claimed back afterwards on a debit note against this same bill, not kept
 * off the bill in the first place. The guard this function exists for is
 * still real: without it the mill could pay for goods that were
 * short-delivered — never turned up at all — and nothing would notice.
 */
/**
 * How much of each receipt line is already claimed by a bill.
 *
 * The inverse of `checkAgainstReceipts`: that one asks whether a bill is
 * running ahead of its receipts, this one asks whether a receipt is being
 * corrected down behind its bills. Both questions have to be asked, and only
 * the first one ever was — so a delivery booked at 650 and billed at 650
 * could be corrected to 400 with nothing to stop it, leaving 250 billed that
 * never arrived.
 *
 * A cancelled bill claims nothing.
 */
async function billedByGrnLine(
  tx: Prisma.TransactionClient,
  grnLineIds: string[]
): Promise<Map<string, { qty: number; bills: string[] }>> {
  if (!grnLineIds.length) return new Map()

  const claims = await tx.purchaseInvoiceLine.findMany({
    where: { grnLineId: { in: grnLineIds }, bill: { status: { not: 'CANCELLED' } } },
    select: { grnLineId: true, qty: true, bill: { select: { billNumber: true } } },
  })

  const out = new Map<string, { qty: number; bills: string[] }>()
  for (const c of claims) {
    if (!c.grnLineId) continue
    const entry = out.get(c.grnLineId) ?? { qty: 0, bills: [] }
    entry.qty = round3(entry.qty + Number(c.qty))
    if (!entry.bills.includes(c.bill.billNumber)) entry.bills.push(c.bill.billNumber)
    out.set(c.grnLineId, entry)
  }
  return out
}

/** The identity of a receipt line, for matching an edit against what is there. */
const grnLineKey = (poLineId: string | null, warehouseId: string, batch: string | null) =>
  `${poLineId ?? '-'}|${warehouseId}|${batch ?? ''}`

async function checkAgainstReceipts(
  tx: Prisma.TransactionClient,
  lines: BillLineInput[],
  supplierId: string,
  excludeBillId?: string
) {
  const grnLineIds = lines
    .map((l) => l.grnLineId)
    .filter((v): v is string => typeof v === 'string' && v.length > 0)

  if (!grnLineIds.length) return

  const receiptLines = await tx.gRNLine.findMany({
    where: { id: { in: grnLineIds } },
    select: {
      id: true,
      receivedQty: true,
      itemId: true,
      item: { select: { name: true } },
      grn: { select: { grnNumber: true, status: true, po: { select: { supplierId: true } } } },
    },
  })
  const receiptById = new Map(receiptLines.map((r) => [r.id, r]))

  /*
   * What earlier bills already claimed against these same receipt lines, and
   * which bills those were. A cancelled bill claims nothing.
   *
   * The bill numbers are carried, not only the totals, because of what has to
   * be said when a receipt is billed a second time. "Only 0 is left to bill"
   * is arithmetically true and tells a clerk nothing they can act on; the
   * sentence that ends the confusion names the bill the goods are already on,
   * so they can go and look at it.
   */
  const claimed = await tx.purchaseInvoiceLine.findMany({
    where: {
      grnLineId: { in: grnLineIds },
      bill: {
        status: { not: 'CANCELLED' },
        ...(excludeBillId ? { id: { not: excludeBillId } } : {}),
      },
    },
    select: { grnLineId: true, qty: true, bill: { select: { billNumber: true } } },
  })
  const claimedById = new Map<string, { qty: number; bills: string[] }>()
  for (const c of claimed) {
    if (!c.grnLineId) continue
    const entry = claimedById.get(c.grnLineId) ?? { qty: 0, bills: [] }
    entry.qty = round3(entry.qty + Number(c.qty))
    if (!entry.bills.includes(c.bill.billNumber)) entry.bills.push(c.bill.billNumber)
    claimedById.set(c.grnLineId, entry)
  }

  // Several bill lines can point at one receipt line; they have to be counted
  // together or each would pass the check on its own.
  const wantedById = new Map<string, number>()
  for (const line of lines) {
    if (!line.grnLineId) continue
    wantedById.set(line.grnLineId, (wantedById.get(line.grnLineId) ?? 0) + line.qty)
  }

  for (const [grnLineId, wanted] of wantedById) {
    const receipt = receiptById.get(grnLineId)
    if (!receipt) {
      throw new AppError('That goods receipt line no longer exists', 400, 'INVALID_GRN_LINE')
    }

    if (receipt.grn.po.supplierId !== supplierId) {
      throw new AppError(
        `${receipt.grn.grnNumber} was received against a different supplier. A bill can only cover this supplier's own receipts.`,
        409,
        'GRN_SUPPLIER_MISMATCH'
      )
    }

    if (receipt.grn.status === 'CANCELLED') {
      throw new AppError(
        `${receipt.grn.grnNumber} was cancelled, so nothing on it can be billed.`,
        409,
        'GRN_CANCELLED'
      )
    }

    const delivered = Number(receipt.receivedQty)
    const prior = claimedById.get(grnLineId) ?? { qty: 0, bills: [] }
    const already = prior.qty
    const room = round3(delivered - already)

    /*
     * Nothing left on this receipt line at all, and a bill already has it.
     *
     * That is not a quantity dispute — it is the same goods being billed
     * twice, which is how a supplier gets paid twice and the input credit
     * gets claimed twice. Refused by name, with the bill that already covers
     * it, and with the way out: a bill that is wrong is cancelled and raised
     * again, never topped up with a second one.
     *
     * A receipt only reaches this state while a live bill holds it. Cancel
     * that bill and the claim disappears with it — every count here is made
     * over bills that are not cancelled — so the receipt goes straight back
     * to needing one, with no flag anywhere that could be left behind.
     */
    if (already > 0 && room <= 0.0005) {
      const which = prior.bills.join(', ')
      throw new AppError(
        `${receipt.grn.grnNumber} is already billed under ${which}. Cannot create a duplicate bill — cancel ${prior.bills.length > 1 ? 'those bills' : which} first if something on it is wrong.`,
        409,
        'GRN_ALREADY_BILLED'
      )
    }

    // Quantities are held to three decimals; comparing raw floats would refuse
    // a bill that is short by a millionth of a metre.
    if (round3(wanted) > room + 0.0005) {
      const name = receipt.item.name
      throw new AppError(
        already > 0
          ? `The bill claims ${round3(wanted)} of ${name}, but only ${room} is left to bill on ${receipt.grn.grnNumber} — ${already} of the ${delivered} delivered has already been billed.`
          : `The bill claims ${round3(wanted)} of ${name}, but only ${delivered} was delivered on ${receipt.grn.grnNumber}. Check the bill against the receipt before booking it.`,
        409,
        'BILLED_MORE_THAN_RECEIVED'
      )
    }
  }
}

router.get('/bills', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const supplierId = typeof req.query.supplierId === 'string' ? req.query.supplierId : ''
  const itemId = typeof req.query.itemId === 'string' ? req.query.itemId : ''
  const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : ''
  const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : ''

  const where: Prisma.PurchaseInvoiceWhereInput = {
    ...(status ? { status: status as Prisma.EnumInvoiceStatusFilter['equals'] } : {}),
    ...(supplierId ? { supplierId } : {}),
    // `some`, not `every`: a bill with thread on it somewhere is still a bill
    // with thread on it.
    ...(itemId ? { lines: { some: { itemId } } } : {}),
    ...(req.query.overdue === 'true'
      ? { dueDate: { lt: new Date() }, status: { in: ['UNPAID', 'PARTIAL'] } }
      : {}),
    ...(q
      ? {
          OR: [
            { billNumber: { contains: q, mode: 'insensitive' as const } },
            { supplierInvoiceNo: { contains: q, mode: 'insensitive' as const } },
            { supplier: { name: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  }

  // A day range, inclusive at both ends — `to` is pushed to the end of its
  // day so a bill booked that afternoon is not quietly dropped from it.
  if (from || to) {
    const range: Prisma.DateTimeFilter = {}
    if (from) range.gte = new Date(`${from}T00:00:00`)
    if (to) range.lte = new Date(`${to}T23:59:59.999`)
    where.billDate = range
  }

  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'billDate'
  const order = req.query.order === 'asc' ? 'asc' : 'desc'
  const sortable = ['billDate', 'billNumber', 'dueDate', 'totalAmount', 'createdAt']
  const orderBy = { [sortable.includes(sort) ? sort : 'billDate']: order }

  const [rows, total] = await Promise.all([
    prisma.purchaseInvoice.findMany({
      where,
      include: billInclude,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.purchaseInvoice.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  })
})

router.get('/bills/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const bill = await prisma.purchaseInvoice.findUnique({
    where: { id: req.params.id },
    include: billInclude,
  })
  if (!bill) throw new AppError('Purchase bill not found', 404, 'NOT_FOUND')

  // A rejection can be noted straight off the receipt before this bill ever
  // existed — see `adjustableOn`. Carried here so the detail screen's
  // "rejected — raise a debit note" note can say so only about what is
  // genuinely still unclaimed, rather than a rejection already noted.
  const notedById = await notedQtyByGrnLine(
    prisma,
    bill.lines.map((l) => l.grnLineId).filter((id): id is string => Boolean(id))
  )

  res.json({
    success: true,
    data: {
      ...bill,
      lines: bill.lines.map((l) => ({
        ...l,
        grnLine: l.grnLine ? { ...l.grnLine, rejectedNotedQty: notedById.get(l.grnLine.id) ?? 0 } : null,
      })),
    },
  })
})

/**
 * What a receipt still has left to bill, ready to fill a new bill in.
 *
 * The clerk should not be retyping quantities off a receipt they already
 * entered — that is how a bill ends up matching nothing.
 */
router.get('/bills/match/:grnId', requirePermission(MODULE, 'view'), async (req, res) => {
  const grn = await prisma.gRN.findUnique({
    where: { id: req.params.grnId },
    include: {
      po: {
        select: {
          id: true,
          poNumber: true,
          supplierId: true,
          supplier: { select: { id: true, name: true, gstin: true } },
        },
      },
      lines: {
        include: {
          item: {
            select: {
              id: true,
              code: true,
              name: true,
              hsnCode: true,
              uom: { select: { symbol: true } },
            },
          },
          poLine: { select: { id: true, unitRate: true, gstRate: true, discount: true } },
        },
      },
    },
  })
  if (!grn) throw new AppError('Goods receipt not found', 404, 'NOT_FOUND')

  const claimed = await prisma.purchaseInvoiceLine.groupBy({
    by: ['grnLineId'],
    where: {
      grnLineId: { in: grn.lines.map((l) => l.id) },
      bill: { status: { not: 'CANCELLED' } },
    },
    _sum: { qty: true },
  })
  const claimedById = new Map(claimed.map((c) => [c.grnLineId, Number(c._sum.qty ?? 0)]))

  // A debit note can already exist against the rejected quantity, raised
  // straight off this receipt before any bill did — see `adjustableOnGrn`.
  // Carried here so the bill form's "rejected — raise a debit note" hint can
  // say so only about what is genuinely still unclaimed, instead of pointing
  // at a rejection that already has a note on it.
  const notedById = await notedQtyByGrnLine(
    prisma,
    grn.lines.map((l) => l.id)
  )

  res.json({
    success: true,
    data: {
      grn: { id: grn.id, grnNumber: grn.grnNumber, grnDate: grn.grnDate, status: grn.status },
      po: grn.po,
      lines: grn.lines.map((l) => {
        const billed = claimedById.get(l.id) ?? 0
        const received = Number(l.receivedQty)
        return {
          grnLineId: l.id,
          item: l.item,
          receivedQty: received,
          acceptedQty: Number(l.acceptedQty),
          // Carried so the bill form can say so while the line is being
          // pulled in, not leave it to be discovered later: this much of
          // what is about to be billed was refused at the gate and is a
          // debit note still to be raised, not stock on the rack.
          rejectedQty: Number(l.rejectedQty),
          // Already claimed by a note raised straight off this receipt,
          // before this bill existed. What the hint above should actually
          // be counted against is `rejectedQty - rejectedNotedQty`, not
          // `rejectedQty` on its own — otherwise a rejection already noted
          // still reads as needing one.
          rejectedNotedQty: notedById.get(l.id) ?? 0,
          billedQty: billed,
          // What is left to bill — against the whole delivery, not just the
          // accepted part of it. A tax invoice from the supplier is written
          // for what they sent, rejects included, and the bill that books
          // it in has to carry the same number.
          pendingQty: round3(received - billed),
          // The rate that was ordered, so a difference on the bill is visible
          // rather than quietly accepted.
          orderedRate: l.poLine ? Number(l.poLine.unitRate) : Number(l.unitRate),
          gstRate: l.poLine ? Number(l.poLine.gstRate) : 0,
          hsnCode: l.item.hsnCode,
        }
      }),
    },
  })
})

/**
 * A bill line whose rate does not match what the order agreed.
 *
 * The rate is the one thing on a purchase bill nobody was checking. Quantity
 * has been matched against the receipt since bills existed, so a supplier
 * could not bill for goods that never arrived — but they could bill the goods
 * that did arrive at any price they liked, and it would post.
 */
interface RateVariance {
  lineIndex: number
  itemName: string
  /** What the order agreed, carried on the receipt line the bill settles. */
  poRate: number
  /** What the supplier has actually charged. */
  billedRate: number
  qty: number
  /** Positive when the supplier charged more than agreed. */
  difference: number
  gstRate: number
  itemId: string
}

/** A paise of drift is rounding, not a dispute. */
const RATE_EPSILON = 0.01

/**
 * Finds every line billed at a rate the order did not agree to.
 *
 * Only lines that settle a receipt can be checked — a transporter's bill or a
 * service has no order rate to compare against, and inventing one would turn
 * a legitimate bill into an argument.
 */
async function findRateVariances(
  tx: Prisma.TransactionClient,
  lines: Array<{ grnLineId?: string | null; unitPrice: number; qty: number; gstRate?: number; itemId: string }>
): Promise<RateVariance[]> {
  const grnLineIds = lines
    .map((l) => l.grnLineId)
    .filter((v): v is string => typeof v === 'string' && v.length > 0)

  if (!grnLineIds.length) return []

  const receiptLines = await tx.gRNLine.findMany({
    where: { id: { in: grnLineIds } },
    select: { id: true, unitRate: true, item: { select: { id: true, name: true } } },
  })
  const byId = new Map(receiptLines.map((r) => [r.id, r]))

  const out: RateVariance[] = []
  lines.forEach((line, lineIndex) => {
    if (!line.grnLineId) return
    const receipt = byId.get(line.grnLineId)
    if (!receipt) return

    const poRate = round2(Number(receipt.unitRate))
    const billedRate = round2(line.unitPrice)
    const difference = round2(billedRate - poRate)

    // A rate of zero on the order means none was ever agreed — an order
    // raised without prices. There is nothing to compare against.
    if (poRate <= 0) return
    if (Math.abs(difference) < RATE_EPSILON) return

    out.push({
      lineIndex,
      itemName: receipt.item.name,
      itemId: receipt.item.id,
      poRate,
      billedRate,
      qty: round3(line.qty),
      difference,
      gstRate: line.gstRate ?? 0,
    })
  })

  return out
}

/**
 * Refuses a bill whose rates have not been reconciled, and works out what
 * each line should actually be booked at.
 *
 * Nothing is decided on the mill's behalf. A rate that does not match is put
 * in front of whoever is booking the bill with both numbers on it, and they
 * say which one stands — the supplier's, with a reason, or the order's, with
 * a debit note for the difference.
 */
function resolveRateVariances(
  variances: RateVariance[],
  lines: Array<{ rateAction?: 'ACCEPT' | 'DEBIT_NOTE' | null }>,
  reason: string | null | undefined
) {
  if (!variances.length) return { effectiveRates: new Map<number, number>(), toDebitNote: [] }

  const undecided = variances.filter((v) => !lines[v.lineIndex]?.rateAction)
  if (undecided.length) {
    throw new AppError(
      `The supplier has billed a different rate than the order agreed — say what to do with each: ${undecided
        .map(
          (v) =>
            `${v.itemName} ordered at ₹${v.poRate.toFixed(2)}, billed at ₹${v.billedRate.toFixed(2)}`
        )
        .join('; ')}.`,
      400,
      'RATE_VARIANCE_UNRESOLVED'
    )
  }

  const accepted = variances.filter(
    (v) => lines[v.lineIndex]?.rateAction === 'ACCEPT' && v.difference > 0
  )
  if (accepted.length && !reason?.trim()) {
    throw new AppError(
      'Say why the higher rate was agreed before booking it.',
      400,
      'RATE_VARIANCE_REASON_REQUIRED'
    )
  }

  // A line taken back to the order's rate is booked at that rate; the gap is
  // claimed from the supplier on a debit note rather than silently paid.
  const effectiveRates = new Map<number, number>()
  const toDebitNote: RateVariance[] = []
  for (const v of variances) {
    if (lines[v.lineIndex]?.rateAction !== 'DEBIT_NOTE') continue
    effectiveRates.set(v.lineIndex, v.poRate)
    // Only an overcharge is worth claiming back. A supplier who billed less
    // than agreed is booked at their own lower figure, which is already what
    // accepting does.
    if (v.difference > 0) toDebitNote.push(v)
  }

  return { effectiveRates, toDebitNote }
}

router.post('/bills', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createBillSchema.parse(req.body)

  const bill = await prisma.$transaction(async (tx) => {
    const billDate = data.billDate ?? new Date()

    // The same supplier bill booked twice claims the input credit twice. The
    // unique index is the real guard; this is the message the clerk should see
    // instead of a constraint error.
    if (data.supplierInvoiceNo) {
      const existing = await tx.purchaseInvoice.findFirst({
        where: { supplierId: data.supplierId, supplierInvoiceNo: data.supplierInvoiceNo },
        select: { billNumber: true },
      })
      if (existing) {
        throw new AppError(
          `Invoice ${data.supplierInvoiceNo} from this supplier is already booked as ${existing.billNumber}.`,
          409,
          'DUPLICATE_SUPPLIER_INVOICE'
        )
      }
    }

    await checkAgainstReceipts(tx, data.lines, data.supplierId)

    // The rate half of the match. Quantity was already checked above; this is
    // what stops a supplier billing the goods that did arrive at their own
    // price.
    const variances = await findRateVariances(tx, data.lines)
    const { effectiveRates, toDebitNote } = resolveRateVariances(
      variances,
      data.lines,
      data.rateVarianceReason
    )

    // Lines taken back to the order's rate are priced at it, so the bill's
    // own total, its tax and what the supplier is paid all agree.
    const effectiveLines = data.lines.map((l, i) =>
      effectiveRates.has(i) ? { ...l, unitPrice: effectiveRates.get(i)! } : l
    )

    const tax = await purchaseTaxContext(tx, data.supplierId)
    const billNumber = await nextDocumentNumber(tx, 'PB', billDate)

    const items = await tx.item.findMany({
      where: { id: { in: data.lines.map((l) => l.itemId) } },
      select: { id: true, hsnCode: true },
    })
    if (items.length !== new Set(data.lines.map((l) => l.itemId)).size) {
      throw new AppError('One of those items no longer exists', 400, 'INVALID_ITEM')
    }
    const hsnById = new Map(items.map((i) => [i.id, i.hsnCode]))

    const charges = data.charges ?? []
    const priced = priceBill({
      lines: effectiveLines,
      charges,
      discountAmount: data.discountAmount ?? 0,
      isIntraState: tax.isIntraState,
      chargeTax: !tax.supplierIsUnregistered || (data.isReverseCharge ?? false),
      isReverseCharge: data.isReverseCharge ?? false,
      tdsRate: data.tdsRate ?? 0,
    })

    const created = await tx.purchaseInvoice.create({
      data: {
        billNumber,
        supplierId: data.supplierId,
        poId: data.poId || null,
        supplierInvoiceNo: data.supplierInvoiceNo ?? null,
        supplierInvoiceDate: data.supplierInvoiceDate ?? null,
        billDate,
        dueDate: data.dueDate ?? null,
        subtotal: priced.subtotal,
        discountAmount: priced.discount,
        taxableAmount: priced.taxable,
        cgst: priced.cgst,
        sgst: priced.sgst,
        igst: priced.igst,
        tdsSection: data.tdsSection ?? null,
        tdsRate: data.tdsRate ?? null,
        tdsAmount: priced.tdsAmount,
        isReverseCharge: data.isReverseCharge ?? false,
        roundOff: priced.roundOff,
        totalAmount: priced.total,
        paidAmount: 0,
        balanceAmount: priced.balance,
        // The reason a higher rate was agreed belongs on the bill itself. It
        // is the only place it survives — the line stores the figure that was
        // booked, not the argument behind it.
        notes:
          variances.length && data.rateVarianceReason?.trim()
            ? `${data.notes ? data.notes + '\n' : ''}Rate agreed: ${data.rateVarianceReason.trim()}`
            : (data.notes ?? null),
        createdById: req.user!.id,
        lines: {
          create: effectiveLines.map((l, i) => ({
            itemId: l.itemId,
            grnLineId: l.grnLineId || null,
            description: l.description ?? null,
            // Frozen at booking, so correcting the item master later cannot
            // change a bill that has already been claimed.
            hsnCode: hsnById.get(l.itemId) ?? null,
            qty: l.qty,
            unitPrice: l.unitPrice,
            discount: l.discount ?? 0,
            taxableValue: priced.pricedLines[i].taxableValue,
            gstRate: priced.pricedLines[i].gstRate,
            cgst: priced.pricedLines[i].cgst,
            sgst: priced.pricedLines[i].sgst,
            igst: priced.pricedLines[i].igst,
            amount: priced.pricedLines[i].amount,
            sortOrder: i,
          })),
        },
        charges: {
          create: charges.map((c, i) => ({
            chargeTypeId: c.chargeTypeId,
            amount: priced.pricedCharges[i].amount,
            gstRate: priced.pricedCharges[i].gstRate,
            cgst: priced.pricedCharges[i].cgst,
            sgst: priced.pricedCharges[i].sgst,
            igst: priced.pricedCharges[i].igst,
          })),
        },
      },
      include: billInclude,
    })

    /*
     * The claim back, for every line booked at the order's rate rather than
     * the supplier's.
     *
     * Raised as a draft, never sent. A debit note is a demand for money from
     * somebody the mill trades with, and it should leave the building because
     * a person decided it should — not because a rate comparison did. It still
     * has to be submitted, approved and posted by hand like any other.
     *
     * Its own tax follows the goods it corrects: the difference is a change
     * to what was supplied, so it carries the line's GST rate and the same
     * intra- or inter-state split the bill was worked out on.
     *
     * Every line points at the bill line it corrects, which is what lets a
     * later return against the same line know that this much of it is already
     * claimed. `sortOrder` is the link: bill lines are written in the order
     * they arrived, and `RateVariance.lineIndex` is a position in that same
     * list.
     */
    if (toDebitNote.length) {
      const noteNumber = await nextDocumentNumber(tx, 'DN', billDate)

      const billLines = await tx.purchaseInvoiceLine.findMany({
        where: { billId: created.id },
        select: { id: true, sortOrder: true },
      })
      const billLineAt = new Map(billLines.map((l) => [l.sortOrder, l.id]))

      const priced = priceNote({
        isIntraState: tax.isIntraState,
        lines: toDebitNote.map((v) => ({
          itemId: v.itemId,
          billLineId: billLineAt.get(v.lineIndex) ?? null,
          description: `Billed at ${v.billedRate.toFixed(2)} against ${v.poRate.toFixed(2)} on the order`,
          hsnCode: hsnById.get(v.itemId) ?? null,
          originalQty: v.qty,
          originalRate: v.billedRate,
          qty: v.qty,
          unitPrice: v.difference,
          gstRate: v.gstRate,
        })),
      })

      await tx.purchaseNote.create({
        data: {
          noteNumber,
          status: 'DRAFT',
          reason: 'WRONG_RATE',
          /* Raised by us, as our own commercial claim, because that is what
             it is: we spotted the rate on their bill and we are claiming the
             difference. Whether the supplier answers with a credit note — and
             whether any of it becomes a GST document — is not known at this
             moment and is deliberately not guessed at. The note lands at
             NOT_REVIEWED and cannot be posted until accounts has said. */
          issuedBy: 'OUR_COMPANY',
          docType: 'OUR_DEBIT_NOTE',
          effect: 'REDUCES_PAYABLE',
          supplierId: data.supplierId,
          billId: created.id,
          poId: created.poId,
          noteDate: billDate,
          reasonNote: `Rate difference on ${created.billNumber}`,
          isIntraState: tax.isIntraState,
          taxableAmount: priced.taxableAmount,
          cgst: priced.cgst,
          sgst: priced.sgst,
          igst: priced.igst,
          roundOff: priced.roundOff,
          totalAmount: priced.totalAmount,
          createdById: req.user!.id,
          lines: {
            create: priced.lines.map((l, i) => ({
              itemId: l.itemId,
              billLineId: l.billLineId ?? null,
              description: l.description ?? null,
              hsnCode: l.hsnCode ?? null,
              originalQty: l.originalQty ?? null,
              originalRate: l.originalRate ?? null,
              qty: l.qty,
              unitPrice: l.unitPrice,
              taxableValue: l.taxableValue,
              gstRate: l.gstRate,
              cgst: l.cgst,
              sgst: l.sgst,
              igst: l.igst,
              amount: l.amount,
              sortOrder: i,
            })),
          },
        },
      })
    }

    return { bill: created, debitNoteRaised: toDebitNote.length > 0 }
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'PurchaseInvoice',
    entityId: bill.bill.id,
    after: bill.bill,
  })

  res.status(201).json({
    success: true,
    data: bill.bill,
    message: bill.debitNoteRaised
      ? `${bill.bill.billNumber} booked at the order's rate. A debit note is waiting in draft for the difference.`
      : undefined,
  })
})

router.patch('/bills/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = updateBillSchema.parse(req.body)

  const before = await prisma.purchaseInvoice.findUnique({
    where: { id: req.params.id },
    include: billInclude,
  })
  if (!before) throw new AppError('Purchase bill not found', 404, 'NOT_FOUND')
  // Held on its own so the work inside the transaction below does not depend
  // on the narrowing surviving all the way down this handler.
  const billId = before.id

  if (before.status === 'CANCELLED') {
    throw new AppError('A cancelled bill cannot be edited', 409, 'BILL_CANCELLED')
  }
  // Once money has moved against it the bill is part of the payment record.
  if (Number(before.paidAmount) > 0) {
    throw new AppError(
      `${before.billNumber} has already been paid against and can no longer be edited. Raise a debit note instead.`,
      409,
      'BILL_PAID'
    )
  }

  const updated = await prisma.$transaction(async (tx) => {
    // The lines are replaced wholesale further down, and a note is pinned to
    // the very rows that replacement deletes.
    await refuseIfNoted(tx, before, 'corrected')

    const supplierId = data.supplierId ?? before.supplierId
    const lines =
      data.lines ??
      before.lines.map((l) => ({
        itemId: l.itemId,
        grnLineId: l.grnLineId,
        description: l.description,
        qty: Number(l.qty),
        unitPrice: Number(l.unitPrice),
        discount: Number(l.discount),
        gstRate: Number(l.gstRate),
      }))

    const supplierInvoiceNo =
      data.supplierInvoiceNo !== undefined ? data.supplierInvoiceNo : before.supplierInvoiceNo

    if (supplierInvoiceNo) {
      const clash = await tx.purchaseInvoice.findFirst({
        where: {
          supplierId,
          supplierInvoiceNo,
          id: { not: before.id },
        },
        select: { billNumber: true },
      })
      if (clash) {
        throw new AppError(
          `Invoice ${supplierInvoiceNo} from this supplier is already booked as ${clash.billNumber}.`,
          409,
          'DUPLICATE_SUPPLIER_INVOICE'
        )
      }
    }

    await checkAgainstReceipts(tx, lines, supplierId, before.id)

    const tax = await purchaseTaxContext(tx, supplierId)
    const charges =
      data.charges ??
      before.charges.map((c) => ({
        chargeTypeId: c.chargeTypeId,
        amount: Number(c.amount),
        gstRate: Number(c.gstRate),
      }))

    const isReverseCharge = data.isReverseCharge ?? before.isReverseCharge
    const tdsRate = data.tdsRate !== undefined ? (data.tdsRate ?? 0) : Number(before.tdsRate ?? 0)

    const priced = priceBill({
      lines,
      charges,
      discountAmount: data.discountAmount ?? Number(before.discountAmount),
      isIntraState: tax.isIntraState,
      chargeTax: !tax.supplierIsUnregistered || isReverseCharge,
      isReverseCharge,
      tdsRate,
    })

    const items = await tx.item.findMany({
      where: { id: { in: lines.map((l) => l.itemId) } },
      select: { id: true, hsnCode: true },
    })
    const hsnById = new Map(items.map((i) => [i.id, i.hsnCode]))

    // Lines and charges are replaced wholesale rather than diffed. A bill is
    // one statement of what the supplier claimed; patching rows individually
    // is how a total stops agreeing with its own lines.
    await tx.purchaseInvoiceLine.deleteMany({ where: { billId: before.id } })
    await tx.purchaseInvoiceCharge.deleteMany({ where: { billId: before.id } })

    return tx.purchaseInvoice.update({
      where: { id: before.id },
      data: {
        supplierId,
        poId: data.poId !== undefined ? data.poId || null : before.poId,
        supplierInvoiceNo: supplierInvoiceNo ?? null,
        supplierInvoiceDate:
          data.supplierInvoiceDate !== undefined
            ? (data.supplierInvoiceDate ?? null)
            : before.supplierInvoiceDate,
        billDate: data.billDate ?? before.billDate,
        dueDate: data.dueDate !== undefined ? (data.dueDate ?? null) : before.dueDate,
        subtotal: priced.subtotal,
        discountAmount: priced.discount,
        taxableAmount: priced.taxable,
        cgst: priced.cgst,
        sgst: priced.sgst,
        igst: priced.igst,
        tdsSection: data.tdsSection !== undefined ? (data.tdsSection ?? null) : before.tdsSection,
        tdsRate: tdsRate || null,
        tdsAmount: priced.tdsAmount,
        isReverseCharge,
        roundOff: priced.roundOff,
        totalAmount: priced.total,
        notes: data.notes !== undefined ? (data.notes ?? null) : before.notes,
        lines: {
          create: lines.map((l, i) => ({
            itemId: l.itemId,
            grnLineId: l.grnLineId || null,
            description: l.description ?? null,
            hsnCode: hsnById.get(l.itemId) ?? null,
            qty: l.qty,
            unitPrice: l.unitPrice,
            discount: l.discount ?? 0,
            taxableValue: priced.pricedLines[i].taxableValue,
            gstRate: priced.pricedLines[i].gstRate,
            cgst: priced.pricedLines[i].cgst,
            sgst: priced.pricedLines[i].sgst,
            igst: priced.pricedLines[i].igst,
            amount: priced.pricedLines[i].amount,
            sortOrder: i,
          })),
        },
        charges: {
          create: charges.map((c, i) => ({
            chargeTypeId: c.chargeTypeId,
            amount: priced.pricedCharges[i].amount,
            gstRate: priced.pricedCharges[i].gstRate,
            cgst: priced.pricedCharges[i].cgst,
            sgst: priced.pricedCharges[i].sgst,
            igst: priced.pricedCharges[i].igst,
          })),
        },
      },
    })

    /*
     * The derived money — what the notes take off, what is left to pay, and
     * whether the bill counts as settled — is written by the one function
     * that owns it, rather than worked out again here.
     *
     * It was worked out again here, and wrongly. The line read
     * `total - tds - paid` and never subtracted `noteAdjustment`, so a bill
     * with a posted note against it came out of an edit still claiming the
     * note's value was owed. `balanceAmount` is what the bills list prints as
     * Outstanding, what the bill window shows, and what the supplier
     * outstanding and purchase register reports sum — so the whole mill would
     * have read the same wrong figure until something else touched the bill
     * and resynced it. `status` was not recomputed either.
     *
     * `refuseIfNoted` above means there is no live note here to subtract, so
     * this changes no number today. It is here because the next person to
     * relax that guard should not have to find this line first.
     */
    await syncBillAdjustments(tx, billId)

    return tx.purchaseInvoice.findUniqueOrThrow({
      where: { id: billId },
      include: billInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseInvoice',
    entityId: updated.id,
    before,
    after: updated,
  })

  res.json({ success: true, data: updated })
})

router.patch(
  '/bills/:id/cancel',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { reason } = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {})

    const before = await prisma.purchaseInvoice.findUnique({ where: { id: req.params.id } })
    if (!before) throw new AppError('Purchase bill not found', 404, 'NOT_FOUND')
    if (before.status === 'CANCELLED') {
      throw new AppError('That bill is already cancelled', 409, 'BILL_CANCELLED')
    }
    if (Number(before.paidAmount) > 0) {
      throw new AppError(
        `${before.billNumber} has payments against it. Reverse those first, or raise a debit note.`,
        409,
        'BILL_PAID'
      )
    }
    /*
     * A posted note against this bill has already taken its value off what
     * the supplier is owed, and where it named a godown it has taken the
     * goods off the rack. This route checked neither: it would cancel the
     * bill and leave the note adjusting a document that no longer exists,
     * with the stock movement standing.
     */
    await refuseIfNoted(prisma, before, 'cancelled')

    // Cancelled, never deleted: the number stays spent and the record stays
    // visible. The quantities it claimed are freed for another bill because the
    // match counts only bills that are not cancelled.
    const after = await prisma.purchaseInvoice.update({
      where: { id: before.id },
      data: {
        status: 'CANCELLED',
        balanceAmount: 0,
        notes: reason
          ? `${before.notes ? before.notes + '\n' : ''}Cancelled: ${reason}`
          : before.notes,
      },
      include: billInclude,
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'PurchaseInvoice',
      entityId: after.id,
      before,
      after,
    })

    res.json({ success: true, data: after, message: `${after.billNumber} cancelled.` })
  }
)

router.get('/bills/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const bill = await prisma.purchaseInvoice.findUnique({
    where: { id: req.params.id },
    include: billInclude,
  })
  if (!bill) throw new AppError('Purchase bill not found', 404, 'NOT_FOUND')

  const header = await getPrintHeader('PB')

  res.json({
    success: true,
    data: {
      ...header,
      bill,
      totalInWords: amountInWords(Number(bill.totalAmount)),
      taxMode: Number(bill.igst) > 0 ? 'IGST' : Number(bill.cgst) > 0 ? 'CGST_SGST' : 'NONE',
    },
  })
})

// ── Supplier payments ───────────────────────────────────────────────────────
//
// What finally settles a bill. Until this existed a bill could be raised and
// matched against its receipts but never paid, so the purchase chain stopped
// one step from the end and every supplier stayed permanently outstanding.

/**
 * The receipts behind one bill, and the files on the order and on each —
 * the same trail the bill's own detail view carries, shared here so the
 * payments screens can show it without opening the bill.
 */
const billTrailSelect = {
  po: {
    select: {
      id: true,
      poNumber: true,
      attachments: {
        select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
      },
    },
  },
  lines: {
    select: {
      id: true,
      grnLine: {
        select: {
          id: true,
          grn: {
            select: {
              id: true,
              grnNumber: true,
              grnDate: true,
              attachments: {
                select: {
                  id: true,
                  fileName: true,
                  mimeType: true,
                  sizeBytes: true,
                  createdAt: true,
                },
              },
            },
          },
        },
      },
    },
  },
}

const paymentInclude = {
  supplier: { select: { id: true, code: true, name: true } },
  reversedBy: { select: { id: true, name: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  bankAccount: { select: { id: true, accountName: true, bankName: true, accountNumber: true } },
  attachments: {
    select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
    orderBy: { createdAt: 'asc' as const },
  },
  invoice: {
    select: {
      id: true,
      billNumber: true,
      supplierInvoiceNo: true,
      billDate: true,
      dueDate: true,
      totalAmount: true,
      paidAmount: true,
      balanceAmount: true,
      status: true,
      ...billTrailSelect,
    },
  },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.SupplierPaymentInclude

/**
 * Re-reads a bill's paid total from its own payments and writes the balance
 * and status to match.
 *
 * Derived rather than incremented, for the same reason stock balances are
 * summed from movements: a running total that is added to on every payment
 * drifts the first time one is entered twice or removed, and then nobody can
 * say which number is true. The payments are the record; this is just their
 * sum written where a list screen can sort on it.
 */
async function syncBillFromPayments(tx: Prisma.TransactionClient, billId: string) {
  const bill = await tx.purchaseInvoice.findUnique({
    where: { id: billId },
    select: {
      id: true,
      totalAmount: true,
      tdsAmount: true,
      noteAdjustment: true,
      status: true,
    },
  })
  if (!bill) throw new AppError('Purchase bill not found', 404, 'NOT_FOUND')

  // A reversed payment settles nothing — the money came back. It stays on
  // the record so the trail still shows the mill tried to pay.
  const paid = await tx.supplierPayment.aggregate({
    where: { invoiceId: billId, status: 'POSTED' },
    _sum: { amount: true, tdsAmount: true },
  })
  const paidAmount = round2(Number(paid._sum.amount ?? 0))
  // Tax withheld at payment goes to the government rather than to the
  // supplier, so it settles the bill exactly as the cash does. Left out, a
  // bill paid net of TDS would sit part-paid for the rest of its life.
  const withheldAmount = round2(Number(paid._sum.tdsAmount ?? 0))

  // TDS is withheld from the supplier rather than paid to them, so the bill is
  // settled in full by the smaller payment. Counting it as outstanding would
  // leave a stub against every contractor forever.
  //
  // A posted debit or credit note comes off the same way: it is money the
  // supplier is no longer owed, so a bill fully covered by payments and an
  // agreed return is settled. `noteAdjustment` is positive where the notes
  // reduce the payable, which is the ordinary case — a supplier who
  // undercharged and raised a debit note on us pushes it the other way.
  //
  // This has to agree with `syncBillAdjustments` in purchaseNote.service.ts,
  // which computes the same figure from the other end. Both subtract TDS and
  // the note adjustment before comparing against what has been paid; if the
  // two ever disagree the balance flips every time a note or a payment is
  // touched.
  const settleable = round2(
    Number(bill.totalAmount) - Number(bill.tdsAmount) - Number(bill.noteAdjustment)
  )
  const balanceAmount = round2(Math.max(0, settleable - paidAmount - withheldAmount))

  // A cancelled bill keeps its own status — money against it is a separate
  // problem and silently reopening it would hide that.
  const status =
    bill.status === 'CANCELLED'
      ? 'CANCELLED'
      : balanceAmount <= 0
        ? 'PAID'
        : paidAmount > 0 || withheldAmount > 0
          ? 'PARTIAL'
          : 'UNPAID'

  return tx.purchaseInvoice.update({
    where: { id: billId },
    data: { paidAmount, balanceAmount, status },
    include: billInclude,
  })
}

router.get('/payments', requirePermission(MODULE, 'view'), async (req, res) => {
  const { supplierId, billId, mode, from, to } = req.query as Record<string, string | undefined>

  const where: Prisma.SupplierPaymentWhereInput = {
    ...(supplierId ? { supplierId } : {}),
    ...(billId ? { invoiceId: billId } : {}),
    ...(mode ? { mode: mode as Prisma.EnumPaymentModeFilter['equals'] } : {}),
    ...(from || to
      ? {
          paymentDate: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          },
        }
      : {}),
  }

  const payments = await prisma.supplierPayment.findMany({
    where,
    include: paymentInclude,
    orderBy: { paymentDate: 'desc' },
  })

  res.json({ success: true, data: payments })
})

/**
 * What is still owed, oldest first.
 *
 * The one screen the teardown of the old system said was missing and worth
 * most: three buyers accounted for the bulk of what was outstanding, and
 * nobody could see it without adding up a ledger by hand.
 */
router.get('/payments/outstanding', requirePermission(MODULE, 'view'), async (req, res) => {
  const { supplierId } = req.query as Record<string, string | undefined>

  const bills = await prisma.purchaseInvoice.findMany({
    where: {
      status: { in: ['UNPAID', 'PARTIAL'] },
      ...(supplierId ? { supplierId } : {}),
    },
    select: {
      id: true,
      billNumber: true,
      supplierInvoiceNo: true,
      billDate: true,
      dueDate: true,
      totalAmount: true,
      tdsAmount: true,
      paidAmount: true,
      balanceAmount: true,
      status: true,
      supplier: { select: { id: true, code: true, name: true } },
      ...billTrailSelect,
    },
    orderBy: [{ dueDate: 'asc' }, { billDate: 'asc' }],
  })

  // Ageing is counted from the due date where the supplier gave terms, and
  // from the bill date where they did not — an undated bill is not "not yet
  // due", it is due now.
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())

  const data = bills.map((b) => {
    const reference = b.dueDate ?? b.billDate
    const refDay = new Date(
      reference.getFullYear(),
      reference.getMonth(),
      reference.getDate()
    )
    const daysOverdue = Math.floor((startOfToday.getTime() - refDay.getTime()) / 86_400_000)

    return {
      ...b,
      daysOverdue: daysOverdue > 0 ? daysOverdue : 0,
      bucket:
        daysOverdue <= 0
          ? 'Not yet due'
          : daysOverdue <= 30
            ? '1-30 days'
            : daysOverdue <= 60
              ? '31-60 days'
              : daysOverdue <= 90
                ? '61-90 days'
                : 'Over 90 days',
    }
  })

  res.json({
    success: true,
    data,
    summary: {
      billCount: data.length,
      totalOutstanding: round2(data.reduce((s, b) => s + Number(b.balanceAmount), 0)),
      overdueCount: data.filter((b) => b.daysOverdue > 0).length,
      overdueAmount: round2(
        data.filter((b) => b.daysOverdue > 0).reduce((s, b) => s + Number(b.balanceAmount), 0)
      ),
    },
  })
})

router.get('/payments/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const payment = await prisma.supplierPayment.findUnique({
    where: { id: req.params.id },
    include: paymentInclude,
  })
  if (!payment) throw new AppError('Payment not found', 404, 'NOT_FOUND')

  res.json({ success: true, data: payment })
})

router.post('/payments', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createPaymentSchema.parse(req.body)

  const payment = await prisma.$transaction(async (tx) => {
    const bill = await tx.purchaseInvoice.findUnique({
      where: { id: data.billId },
      select: {
        id: true,
        billNumber: true,
        supplierId: true,
        status: true,
        totalAmount: true,
        tdsAmount: true,
        noteAdjustment: true,
        billDate: true,
        supplier: { select: { name: true } },
      },
    })
    if (!bill) throw new AppError('That bill no longer exists', 404, 'NOT_FOUND')

    if (bill.status === 'CANCELLED') {
      throw new AppError(
        `${bill.billNumber} is cancelled. Nothing is owed on it.`,
        409,
        'BILL_CANCELLED'
      )
    }

    const when = data.paymentDate ?? new Date()

    // Paying before the bill was raised is somebody typing the wrong year, and
    // it puts the two documents in different periods.
    if (when < new Date(bill.billDate.getFullYear(), bill.billDate.getMonth(), bill.billDate.getDate())) {
      throw new AppError(
        `${bill.billNumber} is dated after this payment. Check the date.`,
        400,
        'PAYMENT_BEFORE_BILL'
      )
    }

    const tds = round2(data.tdsAmount ?? 0)

    // TDS is deducted once. A bill records it when the deduction is known at
    // booking; a payment records it when it was not. Both together would pay
    // the supplier twice short and claim the same deduction twice.
    if (tds > 0 && Number(bill.tdsAmount) > 0) {
      throw new AppError(
        `${bill.billNumber} already has ₹${Number(bill.tdsAmount).toFixed(2)} of tax deducted on it. It comes off once — correct the bill if that figure is wrong.`,
        400,
        'TDS_ALREADY_ON_BILL'
      )
    }

    // Checked here rather than left to the foreign key, which would surface as
    // a database error nobody outside this file can read.
    if (data.warehouseId) {
      const where = await tx.warehouse.findUnique({
        where: { id: data.warehouseId },
        select: { id: true },
      })
      if (!where) throw new AppError('That location no longer exists', 400, 'BAD_LOCATION')
    }

    if (data.bankAccountId) {
      const account = await tx.bankAccount.findUnique({
        where: { id: data.bankAccountId },
        select: { id: true, accountName: true, isActive: true },
      })
      if (!account) throw new AppError('That account no longer exists', 400, 'BAD_ACCOUNT')
      if (!account.isActive) {
        throw new AppError(
          `${account.accountName} is closed. Pick the account the money really left.`,
          400,
          'ACCOUNT_CLOSED'
        )
      }
    }

    // What earlier payments already settled. Summed rather than read off the
    // bill so two clerks paying at the same moment cannot both pass the check
    // against a stale figure. Tax withheld counts: it left the bill even
    // though it never reached the supplier.
    const paid = await tx.supplierPayment.aggregate({
      where: { invoiceId: bill.id, status: 'POSTED' },
      _sum: { amount: true, tdsAmount: true },
    })
    const alreadyPaid = round2(Number(paid._sum.amount ?? 0) + Number(paid._sum.tdsAmount ?? 0))
    /*
     * Posted notes come off before the ceiling is worked out, exactly as they
     * do in `syncBillFromPayments`. The two have to subtract the same things
     * or this guard defends a number the bill does not agree with: the check
     * used to allow the whole bill total against a bill a debit note had
     * already reduced, and the excess then vanished into that function's
     * `Math.max(0, …)` — the supplier overpaid, the bill read PAID, and
     * nothing on the screen said where the difference went.
     */
    const settleable = round2(
      Number(bill.totalAmount) - Number(bill.tdsAmount) - Number(bill.noteAdjustment)
    )
    const owing = round2(settleable - alreadyPaid)

    if (owing <= 0) {
      // Nothing left to pay is not always "paid" — notes can settle a bill on
      // their own, and telling a clerk it was paid would send them looking for
      // a payment that was never made.
      throw new AppError(
        alreadyPaid > 0
          ? `${bill.billNumber} is already paid in full.`
          : `Nothing is owed on ${bill.billNumber} — the notes against it cover the whole bill.`,
        409,
        'BILL_ALREADY_PAID'
      )
    }

    const settles = round2(data.amount + tds)
    if (settles > owing) {
      throw new AppError(
        tds > 0
          ? `₹${data.amount.toFixed(2)} and ₹${tds.toFixed(2)} deducted comes to ₹${settles.toFixed(2)} — only ₹${owing.toFixed(2)} is left on ${bill.billNumber}.`
          : `That is more than is owed — only ₹${owing.toFixed(2)} is left on ${bill.billNumber}.`,
        400,
        'OVERPAYMENT'
      )
    }

    const paymentNumber = await nextDocumentNumber(tx, 'SP', when)

    const created = await tx.supplierPayment.create({
      data: {
        paymentNumber,
        supplierId: bill.supplierId,
        invoiceId: bill.id,
        warehouseId: data.warehouseId || null,
        bankAccountId: data.bankAccountId || null,
        paymentDate: when,
        amount: round2(data.amount),
        tdsAmount: tds,
        mode: data.mode,
        referenceNo: data.referenceNo?.trim() || null,
        chequeNo: data.chequeNo?.trim() || null,
        chequeDate: data.chequeDate ?? null,
        notes: data.notes ?? null,
        createdById: req.user!.id,
      },
      include: paymentInclude,
    })

    await syncBillFromPayments(tx, bill.id)

    return created
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'SupplierPayment',
    entityId: payment.id,
    after: payment,
  })

  res.status(201).json({
    success: true,
    data: payment,
    message: `${payment.paymentNumber} recorded against ${payment.invoice?.billNumber}.`,
  })
})

/**
 * Reverses a payment.
 *
 * Not a delete. A bounced cheque, a duplicate entry, money sent to the wrong
 * account — all of them are things that *happened*, and removing the row
 * removes the evidence that the mill ever tried to pay. The payment stays,
 * stops settling its bill, and the bill reopens for the amount.
 *
 * The document number is not released. The series counts up and never hands
 * the same number out twice, which is the point of it.
 */
router.post(
  '/payments/:id/reverse',
  requirePermission(MODULE, 'delete'),
  async (req: AuthRequest, res) => {
    const { reason } = z
      .object({
        reason: z
          .string({ required_error: 'Say why it is being reversed' })
          .trim()
          .min(3, 'Say why it is being reversed')
          .max(500),
      })
      .parse(req.body ?? {})

    const payment = await prisma.$transaction(async (tx) => {
      const before = await tx.supplierPayment.findUnique({
        where: { id: req.params.id },
        select: { id: true, paymentNumber: true, status: true, invoiceId: true },
      })
      if (!before) throw new AppError('That payment no longer exists', 404, 'NOT_FOUND')
      if (before.status === 'REVERSED') {
        throw new AppError(
          `${before.paymentNumber} is already reversed.`,
          409,
          'ALREADY_REVERSED'
        )
      }

      const updated = await tx.supplierPayment.update({
        where: { id: before.id },
        data: {
          status: 'REVERSED',
          reversedAt: new Date(),
          reversedById: req.user!.id,
          reversalReason: reason,
        },
        include: paymentInclude,
      })

      if (before.invoiceId) await syncBillFromPayments(tx, before.invoiceId)

      return updated
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'SupplierPayment',
      entityId: payment.id,
      after: payment,
    })

    res.json({
      success: true,
      data: payment,
      message: `${payment.paymentNumber} reversed. ${payment.invoice?.billNumber ?? 'The bill'} is owed again.`,
    })
  }
)

// ── Files against a payment ─────────────────────────────────────────────────
//
// The bank advice, the cheque counterfoil, the UTR screenshot. The same three
// steps as an order's files — ask for a link, send the file straight to
// storage, then record it — so the file never travels through the API.

router.get('/payments/:id/attachments', requirePermission(MODULE, 'view'), async (req, res) => {
  const rows = await prisma.supplierPaymentAttachment.findMany({
    where: { paymentId: req.params.id },
    include: attachmentInclude,
    orderBy: { createdAt: 'asc' },
  })
  res.json({ success: true, data: rows })
})

/** Step one: a one-use link to send the file to. Nothing is recorded yet. */
router.post(
  '/payments/:id/attachments/upload-url',
  requirePermission(MODULE, 'create'),
  async (req, res) => {
    const { fileName, sizeBytes } = z
      .object({
        fileName: z.string().min(1, 'The file needs a name').max(255),
        sizeBytes: z
          .number()
          .int()
          .positive('That file is empty')
          .max(MAX_FILE_BYTES, `Files have to be ${MAX_FILE_BYTES / 1024 / 1024}MB or smaller`),
      })
      .parse(req.body)

    const payment = await prisma.supplierPayment.findUnique({
      where: { id: req.params.id },
      select: { id: true, paymentNumber: true },
    })
    if (!payment) throw new AppError('Payment not found', 404, 'NOT_FOUND')

    const already = await prisma.supplierPaymentAttachment.count({
      where: { paymentId: payment.id },
    })
    if (already >= MAX_FILES_PER_DOCUMENT) {
      throw new AppError(
        `${payment.paymentNumber} already has ${MAX_FILES_PER_DOCUMENT} files. Remove one before adding another.`,
        409,
        'TOO_MANY_FILES'
      )
    }

    const path = storagePathFor('supplier-payments', payment.id, fileName)
    const { uploadUrl } = await signedUploadUrl(path)

    res.json({ success: true, data: { uploadUrl, storagePath: path, fileName, sizeBytes } })
  }
)

/** Step three: the file is in the bucket, so record it. */
router.post(
  '/payments/:id/attachments',
  requirePermission(MODULE, 'create'),
  async (req: AuthRequest, res) => {
    const { fileName, storagePath } = z
      .object({
        fileName: z.string().min(1).max(255),
        storagePath: z.string().min(1),
      })
      .parse(req.body)

    const payment = await prisma.supplierPayment.findUnique({
      where: { id: req.params.id },
      select: { id: true, paymentNumber: true },
    })
    if (!payment) throw new AppError('Payment not found', 404, 'NOT_FOUND')

    // A path is only ever handed out for one payment, and this is what stops a
    // reply being replayed against another one.
    if (!storagePath.startsWith(`supplier-payments/${payment.id}/`)) {
      throw new AppError('That file does not belong to this payment', 400, 'WRONG_DOCUMENT')
    }

    // The browser told us the size. Ask storage instead — the row must describe
    // a file that is really there, at the size it really is.
    const { sizeBytes, mimeType } = await statObject(storagePath)
    if (sizeBytes > MAX_FILE_BYTES) {
      await removeObject(storagePath).catch(() => {})
      throw new AppError(
        `That file is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024}MB.`,
        400,
        'FILE_TOO_LARGE'
      )
    }

    const attachment = await prisma.supplierPaymentAttachment.create({
      data: {
        paymentId: payment.id,
        fileName,
        storagePath,
        mimeType,
        sizeBytes,
        uploadedById: req.user!.id,
      },
      include: attachmentInclude,
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'CREATE',
      entityType: 'SupplierPaymentAttachment',
      entityId: attachment.id,
      after: attachment,
    })

    res.status(201).json({ success: true, data: attachment })
  }
)

/** A link that works for a few minutes. The bucket itself stays private. */
router.get('/payment-attachments/:id/link', requirePermission(MODULE, 'view'), async (req, res) => {
  const file = await prisma.supplierPaymentAttachment.findUnique({ where: { id: req.params.id } })
  if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')

  res.json({
    success: true,
    data: { url: await signedDownloadUrl(file.storagePath), fileName: file.fileName },
  })
})

router.delete(
  '/payment-attachments/:id',
  requirePermission(MODULE, 'delete'),
  async (req: AuthRequest, res) => {
    const file = await prisma.supplierPaymentAttachment.findUnique({
      where: { id: req.params.id },
      include: attachmentInclude,
    })
    if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')

    // The row goes first. A row pointing at a file that is gone is a broken
    // download; a file with no row is invisible and merely wastes space.
    await prisma.supplierPaymentAttachment.delete({ where: { id: file.id } })
    await removeObject(file.storagePath).catch(() => {})

    await writeAuditLog(req, {
      module: MODULE,
      action: 'DELETE',
      entityType: 'SupplierPaymentAttachment',
      entityId: file.id,
      before: file,
    })

    res.json({ success: true, message: `${file.fileName} removed.` })
  }
)

export default router
