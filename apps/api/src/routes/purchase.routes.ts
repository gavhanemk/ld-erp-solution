import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { applyRoundOff, nextDocumentNumber } from '../lib/docNumber'
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
import { getNumericPreference } from '../lib/preferences'
import { cancelGrnSchema, createGrnSchema } from '../schemas/grn.schemas'
import {
  createBillSchema,
  updateBillSchema,
  type BillChargeInput,
  type BillLineInput,
} from '../schemas/bill.schemas'

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
    },
    orderBy: [{ mr: { requestDate: 'asc' } }, { id: 'asc' }],
  })

  const rows = lines
    .map((l) => {
      const requested = Number(l.requestedQty)
      const ordered = round3(l.poLines.reduce((t, p) => t + Number(p.qty), 0))
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
        pendingQty: round3(Math.max(0, requested - ordered)),
      }
    })
    .filter((r) => includeDone || r.pendingQty > 0)

  res.json({ success: true, data: rows })
})

router.get('/orders', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

  // Binned orders are not in any list. The recycle bin has a route of its
  // own, so no screen can show them by forgetting to pass something.
  const where: Record<string, unknown> = { deletedAt: null }
  if (typeof req.query.status === 'string' && req.query.status) where.status = req.query.status
  if (typeof req.query.supplierId === 'string' && req.query.supplierId) {
    where.supplierId = req.query.supplierId
  }
  if (q) {
    where.OR = [
      { poNumber: { contains: q, mode: 'insensitive' } },
      { supplier: { name: { contains: q, mode: 'insensitive' } } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: req.query.view === 'picker' ? poPickerInclude : poInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.purchaseOrder.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
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
        enquiryNo: data.enquiryNo ?? null,
        enquiryDate: data.enquiryDate ?? null,
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

  // Once an order is with the supplier, or goods have started arriving against
  // it, editing it silently would leave the paper they hold disagreeing with
  // ours. Cancel and raise a fresh one instead.
  if (before.status !== 'DRAFT') {
    throw new AppError(
      `This order is ${before.status.toLowerCase().replace('_', ' ')} and can no longer be edited. Raise a new one.`,
      400,
      'PO_NOT_DRAFT'
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
    .min(5, 'Say why this line is being closed short — one line is enough')
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

    res.json({ success: true, data: full, message: 'Line closed short. It will not count as pending any more.' })
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

  if (order.status !== 'DRAFT' && order.status !== 'CANCELLED') {
    throw new AppError(
      `${order.poNumber} has gone to the supplier. Cancel it instead — deleting it here would leave them holding paper for an order that no longer exists.`,
      400,
      'PO_SENT'
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
      `${order.poNumber} has ${against} against it, so it cannot be deleted. Cancel it instead.`,
      409,
      'PO_HAS_DOCUMENTS'
    )
  }

  const after = await prisma.purchaseOrder.update({
    where: { id: order.id },
    data: { deletedAt: new Date(), deletedById: req.user?.id ?? null },
  })

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
      item: { select: { id: true, code: true, name: true, uom: { select: { symbol: true } } } },
      warehouse: { select: { id: true, name: true } },
    },
  },
}

/**
 * How much of each order line has actually been accepted, counted from the
 * receipts themselves rather than from a running total on the order.
 *
 * The stored `receivedQty` is a convenience for the order screen; this is the
 * figure every decision is made against, for the same reason a stock balance is
 * summed from its movements — a total somebody keeps updating is a total that
 * can drift away from the documents underneath it.
 *
 * A cancelled receipt is left out, which is what lets a cancellation give the
 * quantity back to the order.
 */
async function acceptedByPoLine(
  tx: Prisma.TransactionClient,
  poLineIds: string[]
): Promise<Map<string, number>> {
  if (poLineIds.length === 0) return new Map()

  const sums = await tx.gRNLine.groupBy({
    by: ['poLineId'],
    where: { poLineId: { in: poLineIds }, grn: { status: { not: 'CANCELLED' } } },
    _sum: { acceptedQty: true },
  })

  return new Map(sums.map((s) => [s.poLineId as string, Number(s._sum.acceptedQty ?? 0)]))
}

/**
 * Puts the order back in step with what has been received.
 *
 * Called after every receipt, every cancellation, and every short-close, so
 * the order's status and its pending quantities are a reading of the receipts
 * rather than a guess made at the time. Rejected goods do not count as
 * received: they are going back on the lorry, and the order still needs those
 * pieces.
 *
 * A line closed short counts as done here without counting as received: its
 * `pendingQty` is pinned at 0 regardless of the ordered-versus-accepted
 * arithmetic that decides every other line, and it does not hold the order
 * back from COMPLETED the way an ordinary shortfall would.
 */
async function syncOrderFromReceipts(tx: Prisma.TransactionClient, poId: string) {
  const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } })
  if (!po || po.deletedAt) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')

  const accepted = await acceptedByPoLine(
    tx,
    po.lines.map((l) => l.id)
  )

  let anyReceived = false
  let allComplete = true

  for (const line of po.lines) {
    const got = accepted.get(line.id) ?? 0
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
    data: rows,
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
    const already = await acceptedByPoLine(
      tx,
      po.lines.map((l) => l.id)
    )

    /*
     * What this receipt is booking against each order line, added up first.
     *
     * One order line may be split across stores — 500kg to the godown and
     * 300kg to the works is one delivery, not two — so the quantity that has
     * to be checked against the order is the sum of this receipt's rows, not
     * any single row. Checking them one at a time would let two rows of 500
     * through against an order for 800.
     */
    const bookingByPoLine = new Map<string, number>()
    for (const line of data.lines) {
      const accepted = round3(round3(line.receivedQty) - round3(line.rejectedQty ?? 0))
      bookingByPoLine.set(
        line.poLineId,
        round3((bookingByPoLine.get(line.poLineId) ?? 0) + accepted)
      )
    }

    /*
     * How far over the ordered quantity a delivery may run before someone has
     * to say why — a roll or a bale routinely lands a fraction over, and
     * refusing that outright just sends the store keeper to type a slightly
     * smaller number than the scale actually showed. Configured in Settings →
     * Preferences → Purchase; 2% until a mill says otherwise.
     */
    const tolerancePercent = await getNumericPreference('grnOverReceiptTolerancePercent', 2)

    // Every line is checked before anything is written. A receipt that books
    // three items in and then refuses the fourth would leave the store keeper
    // guessing which ones landed.
    const overTolerance: string[] = []
    const prepared = data.lines.map((line) => {
      const poLine = poLines.get(line.poLineId)
      if (!poLine) {
        throw new AppError(
          `One of those lines is not on ${po.poNumber}. Reopen the order and try again.`,
          400,
          'LINE_NOT_ON_ORDER'
        )
      }

      if (poLine.shortClosed) {
        throw new AppError(
          `${poLine.item.name} was closed short — reopen that line on the order before receiving more against it.`,
          400,
          'LINE_SHORT_CLOSED'
        )
      }

      const received = round3(line.receivedQty)
      const rejected = round3(line.rejectedQty ?? 0)
      const accepted = round3(received - rejected)
      const ordered = Number(poLine.qty)
      const soFar = already.get(poLine.id) ?? 0

      const booking = bookingByPoLine.get(poLine.id) ?? accepted
      const total = round3(soFar + booking)

      /*
       * Past the tolerance is not refused, only asked about — `overTolerance`
       * collects what to name in that ask, and receiving still goes ahead
       * once `overReceiptReason` is on the payload. A hard refusal here would
       * be the same problem the tolerance exists to solve, just moved a
       * percentage point further out.
       */
      const allowed = round3(ordered * (1 + tolerancePercent / 100))
      if (total > allowed) {
        overTolerance.push(
          `${poLine.item.name}: ${total} against ${ordered} ordered (${tolerancePercent}% allowed without a reason)`
        )
      }

      return {
        poLine,
        warehouseId: line.warehouseId,
        batchNumber: line.batchNumber ?? null,
        orderedQty: ordered,
        received,
        rejected,
        accepted,
        // The rate comes off the order rather than being typed again. It is
        // what was agreed, and what the supplier's bill gets checked against.
        unitRate: Number(poLine.unitRate),
      }
    })

    if (overTolerance.length > 0 && !data.overReceiptReason?.trim()) {
      throw new AppError(
        `This books in more than ordered, past the usual allowance — say why before saving: ${overTolerance.join('; ')}.`,
        400,
        'OVER_RECEIPT_REASON_REQUIRED'
      )
    }

    const warehouseIds = [...new Set(prepared.map((p) => p.warehouseId))]
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
        // Only ever set when overTolerance actually found something —
        // otherwise this is an ordinary receipt and the field stays null.
        overReceiptReason: overTolerance.length > 0 ? (data.overReceiptReason?.trim() ?? null) : null,

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
  po: { select: { id: true, poNumber: true } },
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
          acceptedQty: true,
          unitRate: true,
          grn: { select: { id: true, grnNumber: true } },
        },
      },
    },
  },
  charges: { include: { chargeType: { select: { id: true, name: true } } } },
}

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
 * Refuses a bill for more than was accepted at the gate. This is the whole
 * reason the document exists — without it the mill pays for goods that were
 * short-delivered or rejected, and nothing in the system ever notices.
 */
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
      acceptedQty: true,
      itemId: true,
      item: { select: { name: true } },
      grn: { select: { grnNumber: true, status: true, po: { select: { supplierId: true } } } },
    },
  })
  const receiptById = new Map(receiptLines.map((r) => [r.id, r]))

  // What earlier bills already claimed against these same receipt lines. A
  // cancelled bill claims nothing.
  const claimed = await tx.purchaseInvoiceLine.groupBy({
    by: ['grnLineId'],
    where: {
      grnLineId: { in: grnLineIds },
      bill: {
        status: { not: 'CANCELLED' },
        ...(excludeBillId ? { id: { not: excludeBillId } } : {}),
      },
    },
    _sum: { qty: true },
  })
  const claimedById = new Map(claimed.map((c) => [c.grnLineId, Number(c._sum.qty ?? 0)]))

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

    const accepted = Number(receipt.acceptedQty)
    const already = claimedById.get(grnLineId) ?? 0
    const room = round3(accepted - already)

    // Quantities are held to three decimals; comparing raw floats would refuse
    // a bill that is short by a millionth of a metre.
    if (round3(wanted) > room + 0.0005) {
      const name = receipt.item.name
      throw new AppError(
        already > 0
          ? `The bill claims ${round3(wanted)} of ${name}, but only ${room} is left to bill on ${receipt.grn.grnNumber} — ${already} of the ${accepted} accepted has already been billed.`
          : `The bill claims ${round3(wanted)} of ${name}, but only ${accepted} was accepted on ${receipt.grn.grnNumber}. Check the bill against the receipt before booking it.`,
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

  const where: Prisma.PurchaseInvoiceWhereInput = {
    ...(status ? { status: status as Prisma.EnumInvoiceStatusFilter['equals'] } : {}),
    ...(supplierId ? { supplierId } : {}),
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
  res.json({ success: true, data: bill })
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

  res.json({
    success: true,
    data: {
      grn: { id: grn.id, grnNumber: grn.grnNumber, grnDate: grn.grnDate, status: grn.status },
      po: grn.po,
      lines: grn.lines.map((l) => {
        const billed = claimedById.get(l.id) ?? 0
        return {
          grnLineId: l.id,
          item: l.item,
          acceptedQty: Number(l.acceptedQty),
          billedQty: billed,
          // What is left to bill. Zero means this line is fully billed already.
          pendingQty: round3(Number(l.acceptedQty) - billed),
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
      lines: data.lines,
      charges,
      discountAmount: data.discountAmount ?? 0,
      isIntraState: tax.isIntraState,
      chargeTax: !tax.supplierIsUnregistered || (data.isReverseCharge ?? false),
      isReverseCharge: data.isReverseCharge ?? false,
      tdsRate: data.tdsRate ?? 0,
    })

    return tx.purchaseInvoice.create({
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
        notes: data.notes ?? null,
        createdById: req.user!.id,
        lines: {
          create: data.lines.map((l, i) => ({
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
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'PurchaseInvoice',
    entityId: bill.id,
    after: bill,
  })

  res.status(201).json({ success: true, data: bill })
})

router.patch('/bills/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = updateBillSchema.parse(req.body)

  const before = await prisma.purchaseInvoice.findUnique({
    where: { id: req.params.id },
    include: billInclude,
  })
  if (!before) throw new AppError('Purchase bill not found', 404, 'NOT_FOUND')

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
        balanceAmount: round2(priced.total - priced.tdsAmount - Number(before.paidAmount)),
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

// ── Not built yet ───────────────────────────────────────────────────────────
//
// These used to return an empty list, which made the screens look as though
// they worked and simply had no data. Saying so plainly is more honest.

const notBuilt = (what: string) => (_req: unknown, res: import('express').Response) =>
  res.status(501).json({
    success: false,
    message: `${what} has not been built yet.`,
    code: 'NOT_IMPLEMENTED',
  })

router.get('/payments', notBuilt('Supplier payments'))

export default router
