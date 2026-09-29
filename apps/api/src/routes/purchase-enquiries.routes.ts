import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
import { getPrintHeader } from '../lib/printData'
import {
  MAX_FILES_PER_DOCUMENT,
  MAX_FILE_BYTES,
  removeObject,
  signedDownloadUrl,
  signedUploadUrl,
  statObject,
  storagePathFor,
} from '../lib/storage'
import {
  assertEditKeepsOrdersTrue,
  orderedQtyByEnquiryLine,
  quoteValue,
  refuseIfOrdered,
  refuseIfQuoteOrdered,
  syncEnquiryStatus,
} from '../services/purchaseEnquiry.service'
import {
  addQuoteSchema,
  closeEnquirySchema,
  createEnquirySchema,
  declineQuoteSchema,
  enquiryListQuerySchema,
  recordQuoteSchema,
  updateEnquirySchema,
} from '../schemas/enquiry.schemas'

/**
 * Purchase enquiries — the step between an indent and a purchase order.
 *
 * The mill's old ERP calls this a *provisional PO*. The buyer sends suppliers
 * quantities and, usually, no prices; each answers with a proforma invoice —
 * his own numbered document quoting a rate and saying how long he will hold it;
 * the buyer compares what came back; and the purchase order is raised against
 * the winning PI's number.
 *
 * Mounted at `/api/purchase/enquiries` ahead of the purchase router, so it
 * inherits the same permission module and `/purchase/:id` never swallows these.
 *
 * -- The question is here, the answers are in `quotes` -------------------------
 *
 * One enquiry, many suppliers. The enquiry holds what was asked; each
 * `PurchaseEnquiryQuote` holds one supplier's answer to it. That is what lets
 * the comparison exist at all — the whole reason the old system has a
 * "Supplier Rates" stage — and it is why no rate a supplier gave is ever
 * written through the enquiry form.
 *
 * -- Nothing here is a commitment ---------------------------------------------
 *
 * That is the entire reason the document exists, and it is the line this file
 * is careful not to cross. An enquiry does not reduce what an indent still
 * needs ordered, does not make goods receivable, does not appear in what a
 * supplier is owed, and does not move stock. The one number it contributes
 * anywhere is a figure on the indent list saying "600 of this is already out
 * with a supplier" — shown so the buyer does not enquire twice, and subtracted
 * from nothing.
 *
 * -- Status is read, not written ----------------------------------------------
 *
 * DRAFT then SENT then QUOTED then ORDERED is derived from what exists: an
 * order standing on it, any supplier having answered, any supplier having been
 * sent it. `syncEnquiryStatus` recomputes it, so cancelling an order puts its
 * quantity straight back on the enquiry with nothing to remember to undo.
 * CLOSED is the exception — a decision somebody took, which survives until
 * somebody reopens it.
 */

const MODULE = 'purchase'
const router = Router()

const round2 = (n: number) => Math.round(n * 100) / 100

const enquiryInclude = {
  location: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  lines: {
    orderBy: { sortOrder: 'asc' },
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
      mrLine: { select: { id: true, mr: { select: { id: true, mrNumber: true } } } },
      /*
       * The order lines raised from this one, cancelled ones included.
       *
       * Everything that decides whether a quantity is placed filters these down
       * to live orders itself. They are sent up whole because the screen has a
       * use for the cancelled ones that the server does not: showing that a
       * line was ordered once and the order was pulled is the difference
       * between "nobody has got round to this" and "this was tried and undone".
       */
      poLines: {
        select: {
          id: true,
          qty: true,
          po: {
            select: { id: true, poNumber: true, status: true, poDate: true, deletedAt: true },
          },
        },
      },
    },
  },
  quotes: {
    orderBy: { createdAt: 'asc' },
    include: {
      supplier: {
        select: { id: true, code: true, name: true, gstin: true, stateCode: true, email: true },
      },
      lines: true,
      attachments: {
        orderBy: { createdAt: 'asc' },
        include: { uploadedBy: { select: { id: true, name: true } } },
      },
      /*
       * Live orders only, and that is what `ordered` on the shaped quote means.
       *
       * A cancelled order must leave the supplier exactly as it found him —
       * orderable again, and able to be passed over — or an order raised in
       * error and cancelled the same afternoon would lock his quote for good.
       * The enquiry's own `purchaseOrders` below keeps cancelled ones, because
       * there the list is history rather than a gate.
       */
      purchaseOrders: {
        where: { deletedAt: null, status: { not: 'CANCELLED' } },
        select: { id: true, poNumber: true, status: true },
      },
    },
  },
  attachments: {
    where: { quoteId: null },
    orderBy: { createdAt: 'asc' },
    include: { uploadedBy: { select: { id: true, name: true } } },
  },
  purchaseOrders: {
    where: { deletedAt: null },
    orderBy: { poDate: 'desc' },
    select: {
      id: true,
      poNumber: true,
      poDate: true,
      status: true,
      totalAmount: true,
      enquiryQuoteId: true,
    },
  },
} satisfies Prisma.PurchaseEnquiryInclude

const attachmentInclude = { uploadedBy: { select: { id: true, name: true } } }

type EnquiryRow = Prisma.PurchaseEnquiryGetPayload<{ include: typeof enquiryInclude }>

/**
 * Everything the screen reads off an enquiry that the database does not store.
 *
 * None of it is a column, and none of it should be. An enquiry's value moves
 * every time a supplier answers, and a stored total would be the one number on
 * the screen able to disagree with the quotes under it. `piAmount` — each
 * supplier's own stated total, which does not move — is what is stored.
 *
 * The comparison is computed here rather than on the browser so that the list,
 * the detail screen and the printed sheet cannot each arrive at a different
 * cheapest supplier.
 */
function shape(e: EnquiryRow, orderedByLine?: Map<string, number>) {
  const qtyByLine = new Map(e.lines.map((l) => [l.id, Number(l.qty)]))
  const now = Date.now()

  const quotes = e.quotes.map((q) => {
    const { value, pricedLines } = quoteValue(q.lines, qtyByLine)
    return {
      ...q,
      /** What his rates come to. Separate from `piAmount`, which is his figure. */
      value,
      pricedLines,
      /*
       * A price that has run out. An awarded quote is never expired — the order
       * was placed while the price stood, and relabelling it later would be
       * rewriting history.
       */
      expired:
        q.piValidUntil != null &&
        q.piValidUntil.getTime() < now &&
        q.purchaseOrders.length === 0 &&
        q.declinedAt == null,
      answered: q.piNumber != null,
      ordered: q.purchaseOrders.length > 0,
    }
  })

  /*
   * The cheapest usable answer.
   *
   * Judged on the supplier's own stated PI total where he gave one, and on what
   * his rates come to otherwise — because that is the figure the mill will
   * actually be billed. Declined quotes are out of the running by definition.
   *
   * Deliberately NOT chosen on price alone when the field is uneven: a supplier
   * who priced two of seven lines will always look cheapest, so `pricedLines`
   * travels with the answer and the screen says "4 of 7 priced" beside it. The
   * buyer decides; this only ranks.
   */
  const running = quotes.filter((q) => q.answered && !q.declinedAt)
  const comparable = running.filter((q) => q.pricedLines === e.lines.length)
  const pool = comparable.length > 0 ? comparable : running
  const best =
    pool.length === 0
      ? null
      : pool.reduce((lo, q) => {
          const a = Number(q.piAmount ?? q.value)
          const b = Number(lo.piAmount ?? lo.value)
          return a > 0 && (b <= 0 || a < b) ? q : lo
        })

  return {
    ...e,
    quotes,
    supplierCount: quotes.length,
    answeredCount: quotes.filter((q) => q.answered).length,
    /** Every supplier still in the running has a lapsed price. */
    expired: running.length > 0 && running.every((q) => q.expired),
    /** Whether the ranking above compared like with like. */
    comparable: comparable.length === running.length,
    best: best
      ? {
          quoteId: best.id,
          supplierId: best.supplier.id,
          supplierName: best.supplier.name,
          amount: Number(best.piAmount ?? best.value),
          pricedLines: best.pricedLines,
        }
      : null,
    ...(orderedByLine
      ? {
          lines: e.lines.map((l) => ({
            ...l,
            orderedQty: orderedByLine.get(l.id) ?? 0,
            pendingQty: round2(Math.max(0, Number(l.qty) - (orderedByLine.get(l.id) ?? 0))),
            /** What each supplier said about this line, keyed by quote. */
            quotedBy: Object.fromEntries(
              e.quotes.map((q) => [q.id, q.lines.find((ql) => ql.enquiryLineId === l.id) ?? null])
            ),
          })),
        }
      : {}),
  }
}

/** The one definition of a quote that has lapsed, shared by filter and count. */
const EXPIRED_WHERE = (now: Date): Prisma.PurchaseEnquiryWhereInput => ({
  status: { in: ['SENT', 'QUOTED'] },
  quotes: { some: { piValidUntil: { lt: now }, declinedAt: null } },
})

// -- Reading -----------------------------------------------------------------

router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const q = enquiryListQuerySchema.parse(req.query)
  const now = new Date()

  const where: Prisma.PurchaseEnquiryWhereInput = {
    deletedAt: q.deleted ? { not: null } : null,
    ...(q.status ? { status: { in: q.status } } : {}),
    ...(q.supplierId ? { quotes: { some: { supplierId: q.supplierId } } } : {}),
    ...(q.itemId ? { lines: { some: { itemId: q.itemId } } } : {}),
    ...(q.locationId ? { locationId: q.locationId } : {}),
    ...(q.from || q.to
      ? {
          enquiryDate: {
            ...(q.from ? { gte: new Date(q.from + 'T00:00:00') } : {}),
            ...(q.to ? { lte: new Date(q.to + 'T23:59:59.999') } : {}),
          },
        }
      : {}),
    ...(q.expired ? EXPIRED_WHERE(now) : {}),
    ...(q.q
      ? {
          OR: [
            { enquiryNumber: { contains: q.q, mode: 'insensitive' } },
            { reference: { contains: q.q, mode: 'insensitive' } },
            { remark: { contains: q.q, mode: 'insensitive' } },
            { quotes: { some: { piNumber: { contains: q.q, mode: 'insensitive' } } } },
            { quotes: { some: { supplier: { name: { contains: q.q, mode: 'insensitive' } } } } },
            { lines: { some: { item: { code: { contains: q.q, mode: 'insensitive' } } } } },
            { lines: { some: { item: { name: { contains: q.q, mode: 'insensitive' } } } } },
          ],
        }
      : {}),
  }

  /*
   * The cards describe the same filter as the table, minus the status being
   * looked at. A count that ignored the supplier filter would contradict the
   * rows underneath it; one that kept the status filter would only ever show
   * the card already pressed.
   */
  const summaryWhere: Prisma.PurchaseEnquiryWhereInput = { ...where, status: undefined }

  const [rows, total, summary, expiring] = await Promise.all([
    prisma.purchaseEnquiry.findMany({
      where,
      include: enquiryInclude,
      orderBy: [{ enquiryDate: 'desc' }, { enquiryNumber: 'desc' }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.purchaseEnquiry.count({ where }),
    prisma.purchaseEnquiry.groupBy({
      by: ['status'],
      where: summaryWhere,
      _count: { _all: true },
    }),
    /*
     * Counted on the server for the same reason the notes screen counts its
     * unclassified ones there: a card built from the rows the page happens to
     * hold means "on this page", which is true while there is one page and
     * wrong the moment there are two.
     */
    prisma.purchaseEnquiry.count({ where: { ...summaryWhere, ...EXPIRED_WHERE(now) } }),
  ])

  res.json({
    success: true,
    data: rows.map((e) => shape(e)),
    meta: {
      page: q.page,
      limit: q.limit,
      total,
      pages: Math.ceil(total / q.limit),
      summary: Object.fromEntries(summary.map((s) => [s.status, s._count._all])),
      expiring,
    },
  })
})

/**
 * Every supplier, item and location that has ever appeared on an enquiry.
 *
 * Registered before `/:id`, or Express reads "filter-options" as an id.
 *
 * Built from the whole table rather than from the page, which is the mistake
 * the receipts filters made: dropdowns assembled from the rows on screen offer
 * nothing on a page with nothing on it, and hide the very value somebody is
 * trying to filter down to.
 */
router.get('/filter-options', requirePermission(MODULE, 'view'), async (_req, res) => {
  const [suppliers, items, locations] = await Promise.all([
    prisma.purchaseEnquiryQuote.findMany({
      where: { enquiry: { deletedAt: null } },
      distinct: ['supplierId'],
      select: { supplier: { select: { id: true, code: true, name: true } } },
      orderBy: { supplier: { name: 'asc' } },
    }),
    prisma.purchaseEnquiryLine.findMany({
      where: { enquiry: { deletedAt: null } },
      distinct: ['itemId'],
      select: { item: { select: { id: true, code: true, name: true } } },
      orderBy: { item: { name: 'asc' } },
    }),
    prisma.purchaseEnquiry.findMany({
      where: { deletedAt: null, locationId: { not: null } },
      distinct: ['locationId'],
      select: { location: { select: { id: true, name: true } } },
    }),
  ])

  res.json({
    success: true,
    data: {
      suppliers: suppliers.map((s) => s.supplier),
      items: items.map((i) => i.item),
      locations: locations.map((l) => l.location).filter(Boolean),
    },
  })
})

router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const enquiry = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
    include: enquiryInclude,
  })
  if (!enquiry) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')

  const ordered = await orderedQtyByEnquiryLine(prisma, enquiry.id)
  res.json({ success: true, data: shape(enquiry, ordered) })
})

router.get('/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const enquiry = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
    include: enquiryInclude,
  })
  if (!enquiry) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')

  /*
   * Which supplier's copy to print.
   *
   * An enquiry sent to three suppliers is three different sheets — each one
   * addressed to its own supplier and carrying only his terms. Without
   * `?quote=` the sheet prints as the mill's own working copy, showing every
   * supplier and the comparison, which is the version the buyer files rather
   * than the version anybody is sent.
   */
  const quoteId = typeof req.query.quote === 'string' ? req.query.quote : null
  if (quoteId && !enquiry.quotes.some((q) => q.id === quoteId)) {
    throw new AppError('That supplier is not on this enquiry', 400, 'WRONG_QUOTE')
  }

  const ordered = await orderedQtyByEnquiryLine(prisma, enquiry.id)
  const header = await getPrintHeader('ENQ')

  /*
   * Who each copy goes to, with a full address.
   *
   * The requisition is one sheet sent to every supplier asked, each copy
   * carrying that supplier's own name and address in the Vendor block. The
   * quote rows only carry a name and a GSTIN, so the address is read here.
   * The supplier's own address first; where the master keeps it on a separate
   * address row instead, the default one of those.
   */
  const wanted = quoteId ? enquiry.quotes.filter((q) => q.id === quoteId) : enquiry.quotes
  const suppliers = await prisma.supplier.findMany({
    where: { id: { in: wanted.map((q) => q.supplierId) } },
    select: {
      id: true,
      code: true,
      name: true,
      phone: true,
      email: true,
      gstin: true,
      address: true,
      city: true,
      state: true,
      stateCode: true,
      pincode: true,
      addresses: {
        where: { isActive: true },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        take: 1,
        select: { address: true, city: true, state: true, stateCode: true, pincode: true },
      },
    },
  })
  const supplierById = new Map(suppliers.map((s) => [s.id, s]))
  const recipients = wanted
    .map((q) => {
      const s = supplierById.get(q.supplierId)
      if (!s) return null
      const alt = s.address ? null : s.addresses[0]
      return {
        quoteId: q.id,
        code: s.code,
        name: s.name,
        phone: s.phone,
        email: s.email,
        gstin: s.gstin,
        address: s.address ?? alt?.address ?? null,
        city: s.city ?? alt?.city ?? null,
        state: s.state ?? alt?.state ?? null,
        stateCode: s.stateCode ?? alt?.stateCode ?? null,
        pincode: s.pincode ?? alt?.pincode ?? null,
      }
    })
    .filter(Boolean)

  /*
   * Where the goods are to be delivered — the godown the enquiry names — and
   * who raised it, for the Prepared By block and the "for queries" line.
   */
  const [shipTo, preparedBy] = await Promise.all([
    enquiry.locationId
      ? prisma.warehouse.findUnique({
          where: { id: enquiry.locationId },
          select: { name: true, address: true },
        })
      : null,
    prisma.user.findUnique({
      where: { id: enquiry.createdById },
      select: { name: true, phone: true, email: true },
    }),
  ])

  res.json({
    success: true,
    data: {
      ...header,
      enquiry: shape(enquiry, ordered),
      forQuoteId: quoteId,
      recipients,
      shipTo,
      preparedBy,
    },
  })
})

// -- Writing -----------------------------------------------------------------

/**
 * Turns the submitted lines into rows, freezing what has to be frozen.
 *
 * The HSN is copied off the item rather than referenced, for the same reason a
 * purchase order copies it: an item's HSN gets corrected, and a document
 * already with a supplier must not change because of it.
 *
 * The items are checked in one query rather than per line. At roughly 300ms a
 * round trip to the pooler, a seven-line enquiry validated line by line spends
 * two seconds doing what one query does.
 */
async function buildLines(
  tx: Prisma.TransactionClient,
  lines: Array<{
    itemId: string
    description?: string | null
    qty: number
    expectedRate?: number | null
    mrLineId?: string | null
  }>
) {
  const items = await tx.item.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.itemId))] } },
    select: { id: true, hsnCode: true },
  })
  const byId = new Map(items.map((i) => [i.id, i]))

  return lines.map((l, i) => {
    const item = byId.get(l.itemId)
    if (!item) throw new AppError('One of those items no longer exists', 400, 'BAD_ITEM')
    return {
      itemId: l.itemId,
      description: l.description ?? null,
      hsnCode: item.hsnCode ?? null,
      qty: l.qty,
      expectedRate: l.expectedRate ?? null,
      mrLineId: l.mrLineId || null,
      sortOrder: i,
    }
  })
}

/** The supplier rows for an enquiry, with each one's place of supply frozen. */
async function buildQuotes(tx: Prisma.TransactionClient, supplierIds: string[]) {
  if (supplierIds.length === 0) return []
  const unique = [...new Set(supplierIds)]
  const suppliers = await tx.supplier.findMany({
    where: { id: { in: unique } },
    select: { id: true, stateCode: true, gstin: true },
  })
  if (suppliers.length !== unique.length) {
    throw new AppError('One of those suppliers no longer exists', 400, 'BAD_SUPPLIER')
  }
  return suppliers.map((s) => ({
    supplierId: s.id,
    /*
     * Falls back to the supplier's own state. A rate quoted with no place of
     * supply cannot be read as CGST+SGST or IGST, and comparing two suppliers
     * in different states without it compares two different things.
     */
    placeOfSupplyCode: s.stateCode ?? s.gstin?.slice(0, 2) ?? null,
  }))
}

router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createEnquirySchema.parse(req.body)

  const created = await prisma.$transaction(async (tx) => {
    const enquiryDate = data.enquiryDate ?? new Date()
    const enquiryNumber = await nextDocumentNumber(tx, 'ENQ', enquiryDate)

    return tx.purchaseEnquiry.create({
      data: {
        enquiryNumber,
        enquiryDate,
        requiredDate: data.requiredDate ?? null,
        locationId: data.locationId || null,
        reference: data.reference ?? null,
        notes: data.notes ?? null,
        terms: data.terms ?? null,
        remark: data.remark ?? null,
        createdById: req.user!.id,
        lines: { create: await buildLines(tx, data.lines) },
        quotes: { create: await buildQuotes(tx, data.supplierIds ?? []) },
      },
      include: enquiryInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'PurchaseEnquiry',
    entityId: created.id,
    after: created,
  })

  res.status(201).json({ success: true, data: shape(created) })
})

/** Loads an enquiry and refuses the edit if it is binned or closed. */
async function editable(id: string) {
  const before = await prisma.purchaseEnquiry.findUnique({
    where: { id },
    include: enquiryInclude,
  })
  if (!before) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')
  if (before.deletedAt) {
    throw new AppError(
      before.enquiryNumber + ' is in the recycle bin. Restore it before editing.',
      409,
      'DELETED'
    )
  }
  if (before.status === 'CLOSED') {
    throw new AppError(
      before.enquiryNumber + ' is closed. Reopen it before editing.',
      409,
      'ENQUIRY_CLOSED'
    )
  }
  return before
}

/**
 * Correcting an enquiry.
 *
 * Open while an order stands on it, narrowly. An enquiry for 1,240 with 600
 * ordered can have the other 640 corrected without touching that order —
 * refusing every edit would force cancelling a correct order to fix a typing
 * mistake unrelated to it, which is how corrections stop being made. What is
 * refused is only what would break: removing a line an order was raised from,
 * or cutting one below what has already been placed against it.
 *
 * Lines arrive whole, and an `id` on a submitted line is what says "this is the
 * same line". Without it every save would look like seven removals and seven
 * additions — which defeats the guard, throws away every rate the suppliers
 * quoted against those lines, and cuts any order loose from the line it was
 * quoted on.
 */
router.patch('/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = updateEnquirySchema.parse(req.body)
  const before = await editable(req.params.id)
  const enquiryId = before.id

  const updated = await prisma.$transaction(async (tx) => {
    if (data.lines) {
      await assertEditKeepsOrdersTrue(
        tx,
        before,
        data.lines.map((l) => ({ id: l.id ?? null, qty: l.qty }))
      )

      const rows = await buildLines(tx, data.lines)
      const kept = data.lines.map((l) => l.id).filter((id): id is string => Boolean(id))

      /*
       * Updated in place, never deleted and rewritten.
       *
       * Rewriting is the obvious way to do this and is wrong three times over.
       * It throws away every rate the suppliers quoted, because those hang off
       * the line's id. It defeats the guard above, since every line then looks
       * new. And `PurchaseOrderLine.enquiryLineId` is `onDelete: SetNull`, so
       * deleting the line an order was quoted on does not fail — it quietly
       * cuts the order loose, and the enquiry goes back to reading as though
       * nothing had been ordered against it.
       */
      await tx.purchaseEnquiryLine.deleteMany({
        where: { enquiryId, ...(kept.length ? { id: { notIn: kept } } : {}) },
      })

      for (let i = 0; i < rows.length; i++) {
        const id = data.lines[i].id
        const row = rows[i]
        if (id) {
          await tx.purchaseEnquiryLine.update({ where: { id }, data: row })
        } else {
          await tx.purchaseEnquiryLine.create({ data: { ...row, enquiryId } })
        }
      }
    }

    await tx.purchaseEnquiry.update({
      where: { id: enquiryId },
      data: {
        ...(data.enquiryDate !== undefined ? { enquiryDate: data.enquiryDate } : {}),
        ...(data.requiredDate !== undefined ? { requiredDate: data.requiredDate ?? null } : {}),
        ...(data.locationId !== undefined ? { locationId: data.locationId || null } : {}),
        ...(data.reference !== undefined ? { reference: data.reference ?? null } : {}),
        ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
        ...(data.terms !== undefined ? { terms: data.terms ?? null } : {}),
        ...(data.remark !== undefined ? { remark: data.remark ?? null } : {}),
      },
    })

    await syncEnquiryStatus(tx, enquiryId)
    return tx.purchaseEnquiry.findUniqueOrThrow({
      where: { id: enquiryId },
      include: enquiryInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseEnquiry',
    entityId: enquiryId,
    before,
    after: updated,
  })

  res.json({ success: true, data: shape(updated) })
})

// -- One supplier's answer ---------------------------------------------------

/** Loads a quote with enough of its enquiry to refuse an edit properly. */
async function quoteFor(quoteId: string) {
  const quote = await prisma.purchaseEnquiryQuote.findUnique({
    where: { id: quoteId },
    include: {
      supplier: { select: { id: true, name: true } },
      lines: true,
      enquiry: { select: { id: true, enquiryNumber: true, status: true, deletedAt: true } },
      purchaseOrders: { where: { deletedAt: null }, select: { poNumber: true } },
    },
  })
  if (!quote) throw new AppError('That supplier is not on this enquiry', 404, 'NOT_FOUND')
  if (quote.enquiry.deletedAt) {
    throw new AppError(quote.enquiry.enquiryNumber + ' is in the recycle bin.', 409, 'DELETED')
  }
  if (quote.enquiry.status === 'CLOSED') {
    throw new AppError(
      quote.enquiry.enquiryNumber + ' is closed. Reopen it first.',
      409,
      'ENQUIRY_CLOSED'
    )
  }
  return quote
}

/** Adding a supplier to an enquiry already raised. */
router.post('/:id/quotes', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = addQuoteSchema.parse(req.body)
  const enquiry = await editable(req.params.id)

  if (enquiry.quotes.some((q) => q.supplierId === data.supplierId)) {
    throw new AppError(
      'That supplier is already on ' + enquiry.enquiryNumber + '.',
      409,
      'DUPLICATE_SUPPLIER'
    )
  }

  const created = await prisma.$transaction(async (tx) => {
    const [row] = await buildQuotes(tx, [data.supplierId])
    await tx.purchaseEnquiryQuote.create({
      data: {
        enquiryId: enquiry.id,
        supplierId: row.supplierId,
        placeOfSupplyCode: data.placeOfSupplyCode ?? row.placeOfSupplyCode,
        remark: data.remark ?? null,
      },
    })
    await syncEnquiryStatus(tx, enquiry.id)
    return tx.purchaseEnquiry.findUniqueOrThrow({
      where: { id: enquiry.id },
      include: enquiryInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseEnquiry',
    entityId: enquiry.id,
    before: enquiry,
    after: created,
  })

  res.status(201).json({ success: true, data: shape(created) })
})

/**
 * Taking a supplier off.
 *
 * Refused while an order stands on his PI — that order quotes his number as the
 * reference its price is defended with. Removing a supplier who answered but
 * lost is ordinary and allowed; the losing quote is usually better *declined*
 * than removed, so the reason survives, and the message says so.
 */
router.delete(
  '/quotes/:quoteId',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const quote = await quoteFor(req.params.quoteId)

    await prisma.$transaction(async (tx) => {
      await refuseIfQuoteOrdered(tx, { id: quote.id, supplierName: quote.supplier.name }, 'removed')
      await tx.purchaseEnquiryQuote.delete({ where: { id: quote.id } })
      await syncEnquiryStatus(tx, quote.enquiry.id)
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'DELETE',
      entityType: 'PurchaseEnquiryQuote',
      entityId: quote.id,
      before: quote,
    })

    res.json({
      success: true,
      message:
        quote.supplier.name +
        ' taken off ' +
        quote.enquiry.enquiryNumber +
        '.' +
        (quote.piNumber ? ' His proforma invoice went with him.' : ''),
    })
  }
)

/**
 * Marking one supplier's copy as gone out.
 *
 * Stamps when, rather than flipping a flag, because the useful question later
 * is not whether it was sent but how long ago — a supplier who has had it for
 * three weeks is a different conversation from one who got it this morning.
 *
 * Idempotent. Pressing it twice does not move the date, or the mill would lose
 * the day it actually went out to the day somebody clicked again.
 */
router.patch(
  '/quotes/:quoteId/send',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const quote = await quoteFor(req.params.quoteId)

    const updated = await prisma.$transaction(async (tx) => {
      if (!quote.sentAt) {
        await tx.purchaseEnquiryQuote.update({
          where: { id: quote.id },
          data: { sentAt: new Date() },
        })
      }
      await syncEnquiryStatus(tx, quote.enquiry.id)
      return tx.purchaseEnquiry.findUniqueOrThrow({
        where: { id: quote.enquiry.id },
        include: enquiryInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'PurchaseEnquiryQuote',
      entityId: quote.id,
      before: quote,
      after: updated,
    })

    res.json({
      success: true,
      data: shape(updated),
      message: quote.sentAt
        ? quote.supplier.name + ' was already marked sent.'
        : quote.enquiry.enquiryNumber + ' marked as sent to ' + quote.supplier.name + '.',
    })
  }
)

/**
 * Sending it to everybody who has not had it yet.
 *
 * The ordinary case. An enquiry raised for three suppliers goes to all three at
 * once, and marking them one at a time is three clicks that say the same thing.
 * Suppliers already sent are skipped rather than re-stamped, so pressing it
 * again after adding a fourth sends only to the fourth.
 */
router.patch('/:id/send', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const enquiry = await editable(req.params.id)
  const pending = enquiry.quotes.filter((q) => !q.sentAt)

  if (enquiry.quotes.length === 0) {
    throw new AppError(
      'Add at least one supplier to ' + enquiry.enquiryNumber + ' before sending it.',
      409,
      'NO_SUPPLIERS'
    )
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (pending.length) {
      await tx.purchaseEnquiryQuote.updateMany({
        where: { id: { in: pending.map((q) => q.id) } },
        data: { sentAt: new Date() },
      })
    }
    await syncEnquiryStatus(tx, enquiry.id)
    return tx.purchaseEnquiry.findUniqueOrThrow({
      where: { id: enquiry.id },
      include: enquiryInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseEnquiry',
    entityId: enquiry.id,
    before: enquiry,
    after: updated,
  })

  res.json({
    success: true,
    data: shape(updated),
    message:
      pending.length === 0
        ? 'Every supplier on ' + enquiry.enquiryNumber + ' already had it.'
        : enquiry.enquiryNumber +
          ' marked as sent to ' +
          (pending.length === 1 ? '1 supplier' : pending.length + ' suppliers') +
          '.',
  })
})

/**
 * Recording one supplier's proforma invoice.
 *
 * Allowed before his copy has been marked sent, and stamps the sent date if it
 * is missing. Plenty of enquiries are made by phone and confirmed by a PI
 * arriving an hour later, and refusing to record his document because nobody
 * pressed Send first would push the step back onto email — which is exactly
 * where it was.
 *
 * Re-recordable. A revised PI against the same supplier is ordinary: he quotes,
 * the buyer pushes back, he sends a second one. The latest is what stands, and
 * the audit log holds the ones before it.
 *
 * His total is stored as he stated it and is not reconciled against the rates.
 * Where the two disagree the screen says so; it does not pick a winner.
 */
router.patch(
  '/quotes/:quoteId/quote',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const data = recordQuoteSchema.parse(req.body)
    const quote = await quoteFor(req.params.quoteId)

    if (data.validUntil && data.validUntil < data.piDate) {
      throw new AppError(
        'The PI cannot expire before the date on it. Check the validity.',
        400,
        'BAD_VALIDITY'
      )
    }

    const mine = new Set(
      (
        await prisma.purchaseEnquiryLine.findMany({
          where: { enquiryId: quote.enquiry.id },
          select: { id: true },
        })
      ).map((l) => l.id)
    )
    for (const r of data.rates ?? []) {
      if (!mine.has(r.lineId)) {
        throw new AppError(
          'One of those rates is against a line that is not on this enquiry',
          400,
          'WRONG_LINE'
        )
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      for (const r of data.rates ?? []) {
        const patch = {
          quotedRate: r.quotedRate ?? null,
          gstRate: r.gstRate ?? null,
          offeredQty: r.offeredQty ?? null,
          remark: r.remark ?? null,
        }
        /*
         * Upserted on (quote, line). A supplier who priced four lines the first
         * time and six the second must end up with six rows, not ten — and a
         * line he has stopped pricing must lose its rate rather than keep the
         * one he gave a fortnight ago.
         */
        await tx.purchaseEnquiryQuoteLine.upsert({
          where: { quoteId_enquiryLineId: { quoteId: quote.id, enquiryLineId: r.lineId } },
          create: { quoteId: quote.id, enquiryLineId: r.lineId, ...patch },
          update: patch,
        })
      }

      await tx.purchaseEnquiryQuote.update({
        where: { id: quote.id },
        data: {
          piNumber: data.piNumber,
          piDate: data.piDate,
          piAmount: data.amount ?? null,
          piValidUntil: data.validUntil ?? null,
          piReceivedAt: new Date(),
          ...(quote.sentAt ? {} : { sentAt: data.piDate }),
          ...(data.remark ? { remark: data.remark } : {}),
          // A supplier who has answered is back in the running, whatever was
          // decided before his revised PI arrived.
          declinedAt: null,
          declinedReason: null,
        },
      })

      await syncEnquiryStatus(tx, quote.enquiry.id)
      return tx.purchaseEnquiry.findUniqueOrThrow({
        where: { id: quote.enquiry.id },
        include: enquiryInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'PurchaseEnquiryQuote',
      entityId: quote.id,
      before: quote,
      after: updated,
    })

    res.json({
      success: true,
      data: shape(updated),
      message: 'PI ' + data.piNumber + ' recorded for ' + quote.supplier.name + '.',
    })
  }
)

/**
 * Passing a supplier over.
 *
 * Not a deletion. His quote stays on the enquiry with the reason against it, so
 * the record says the mill asked him, he answered, and why he did not get it —
 * which is what the buyer needs next time somebody asks whether he is worth
 * approaching. Reversed on its own the moment he sends a revised PI.
 */
router.patch(
  '/quotes/:quoteId/decline',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { reason } = declineQuoteSchema.parse(req.body)
    const quote = await quoteFor(req.params.quoteId)

    const updated = await prisma.$transaction(async (tx) => {
      await refuseIfQuoteOrdered(
        tx,
        { id: quote.id, supplierName: quote.supplier.name },
        'passed over'
      )
      await tx.purchaseEnquiryQuote.update({
        where: { id: quote.id },
        data: { declinedAt: new Date(), declinedReason: reason },
      })
      await syncEnquiryStatus(tx, quote.enquiry.id)
      return tx.purchaseEnquiry.findUniqueOrThrow({
        where: { id: quote.enquiry.id },
        include: enquiryInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'PurchaseEnquiryQuote',
      entityId: quote.id,
      before: quote,
      after: updated,
    })

    res.json({
      success: true,
      data: shape(updated),
      message: quote.supplier.name + ' passed over.',
    })
  }
)

/** Putting a passed-over supplier back in the running. */
router.patch(
  '/quotes/:quoteId/reconsider',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const quote = await quoteFor(req.params.quoteId)
    if (!quote.declinedAt) {
      throw new AppError(quote.supplier.name + ' has not been passed over.', 409, 'NOT_DECLINED')
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.purchaseEnquiryQuote.update({
        where: { id: quote.id },
        // The reason is kept. It records a decision that was taken, and that
        // stays true even after the decision is reversed.
        data: { declinedAt: null },
      })
      await syncEnquiryStatus(tx, quote.enquiry.id)
      return tx.purchaseEnquiry.findUniqueOrThrow({
        where: { id: quote.enquiry.id },
        include: enquiryInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'PurchaseEnquiryQuote',
      entityId: quote.id,
      before: quote,
      after: updated,
    })

    res.json({
      success: true,
      data: shape(updated),
      message: quote.supplier.name + ' back in the running.',
    })
  }
)

// -- The whole document ------------------------------------------------------

/**
 * Dropping an enquiry, with the reason on the record.
 *
 * Refused while a live order stands on it: that order carries a PI number from
 * one of these quotes as the reference its price is defended with, and closing
 * the enquiry underneath it leaves the order quoting a document nobody will
 * look at again.
 */
router.patch('/:id/close', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = closeEnquirySchema.parse(req.body)

  const before = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
    select: { id: true, enquiryNumber: true, status: true, deletedAt: true },
  })
  if (!before) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')
  if (before.deletedAt) {
    throw new AppError(before.enquiryNumber + ' is in the recycle bin.', 409, 'DELETED')
  }
  if (before.status === 'CLOSED') {
    throw new AppError(before.enquiryNumber + ' is already closed.', 409, 'ENQUIRY_CLOSED')
  }

  const updated = await prisma.$transaction(async (tx) => {
    await refuseIfOrdered(tx, before, 'closed')
    return tx.purchaseEnquiry.update({
      where: { id: before.id },
      data: { status: 'CLOSED', closeReason: reason, closedAt: new Date() },
      include: enquiryInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseEnquiry',
    entityId: before.id,
    before,
    after: updated,
  })

  res.json({
    success: true,
    data: shape(updated),
    message: before.enquiryNumber + ' closed.',
  })
})

/**
 * Reopening a closed enquiry.
 *
 * The status it lands on is worked out from what is on it, not from what it was
 * before — a supplier who answers three weeks after the buyer gave up reopens
 * it into QUOTED, because the PI is there.
 *
 * The reason it was closed is kept rather than cleared. It records a decision
 * that was taken, and that stays true even after the decision is reversed.
 */
router.patch('/:id/reopen', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const before = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
    select: { id: true, enquiryNumber: true, status: true, deletedAt: true },
  })
  if (!before) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')
  if (before.deletedAt) {
    throw new AppError(before.enquiryNumber + ' is in the recycle bin.', 409, 'DELETED')
  }
  if (before.status !== 'CLOSED') {
    throw new AppError(before.enquiryNumber + ' is not closed.', 409, 'NOT_CLOSED')
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Out of CLOSED first, or syncEnquiryStatus declines to touch it.
    await tx.purchaseEnquiry.update({
      where: { id: before.id },
      data: { status: 'DRAFT', closedAt: null },
    })
    await syncEnquiryStatus(tx, before.id)
    return tx.purchaseEnquiry.findUniqueOrThrow({
      where: { id: before.id },
      include: enquiryInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseEnquiry',
    entityId: before.id,
    before,
    after: updated,
  })

  res.json({
    success: true,
    data: shape(updated),
    message: before.enquiryNumber + ' reopened as ' + updated.status.toLowerCase() + '.',
  })
})

/**
 * Into the recycle bin, not out of existence.
 *
 * Marked and passed over, the same as a purchase order: the enquiry number is
 * burnt either way — the mill never reuses a document number — so destroying
 * the row would leave a gap in the series nobody can account for. A binned
 * enquiry can be put back whole.
 */
router.delete('/:id', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const before = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
    select: { id: true, enquiryNumber: true, deletedAt: true },
  })
  if (!before) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')
  if (before.deletedAt) {
    throw new AppError(before.enquiryNumber + ' is already in the recycle bin.', 409, 'DELETED')
  }

  await prisma.$transaction(async (tx) => {
    await refuseIfOrdered(tx, before, 'deleted')
    await tx.purchaseEnquiry.update({
      where: { id: before.id },
      data: { deletedAt: new Date(), deletedById: req.user!.id },
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'DELETE',
    entityType: 'PurchaseEnquiry',
    entityId: before.id,
    before,
  })

  res.json({ success: true, message: before.enquiryNumber + ' moved to the recycle bin.' })
})

router.post('/:id/restore', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const before = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
    select: { id: true, enquiryNumber: true, deletedAt: true },
  })
  if (!before) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')
  if (!before.deletedAt) {
    throw new AppError(before.enquiryNumber + ' is not in the recycle bin.', 409, 'NOT_DELETED')
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.purchaseEnquiry.update({
      where: { id: before.id },
      data: { deletedAt: null, deletedById: null },
    })
    await syncEnquiryStatus(tx, before.id)
    return tx.purchaseEnquiry.findUniqueOrThrow({
      where: { id: before.id },
      include: enquiryInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseEnquiry',
    entityId: before.id,
    before,
    after: updated,
  })

  res.json({ success: true, data: shape(updated), message: before.enquiryNumber + ' restored.' })
})

// -- Files -------------------------------------------------------------------
//
// A drawing or a specification belongs to the enquiry and every supplier sees
// the same one. A scanned proforma invoice belongs to the supplier who sent it,
// and `?quote=` is what says which — filing three PDFs against the enquiry
// would leave a list with nothing saying whose each was.
//
// Uploads go straight to storage on a signed URL and the row is written after,
// so a file that never finished uploading leaves no attachment claiming it did.

router.get('/:id/attachments', requirePermission(MODULE, 'view'), async (req, res) => {
  const rows = await prisma.purchaseEnquiryAttachment.findMany({
    where: { enquiryId: req.params.id },
    include: attachmentInclude,
    orderBy: { createdAt: 'asc' },
  })
  res.json({ success: true, data: rows })
})

router.post('/:id/attachments/upload-url', requirePermission(MODULE, 'edit'), async (req, res) => {
  const { fileName, sizeBytes } = z
    .object({
      fileName: z.string().min(1, 'The file needs a name').max(255),
      sizeBytes: z
        .number()
        .int()
        .positive('That file is empty')
        .max(MAX_FILE_BYTES, 'Files have to be ' + MAX_FILE_BYTES / 1024 / 1024 + 'MB or smaller'),
    })
    .parse(req.body)

  const enquiry = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
    select: { id: true, enquiryNumber: true },
  })
  if (!enquiry) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')

  const already = await prisma.purchaseEnquiryAttachment.count({ where: { enquiryId: enquiry.id } })
  if (already >= MAX_FILES_PER_DOCUMENT) {
    throw new AppError(
      enquiry.enquiryNumber +
        ' already has ' +
        MAX_FILES_PER_DOCUMENT +
        ' files. Remove one before adding another.',
      409,
      'TOO_MANY_FILES'
    )
  }

  const path = storagePathFor('purchase-enquiries', enquiry.id, fileName)
  const { uploadUrl } = await signedUploadUrl(path)
  res.json({ success: true, data: { uploadUrl, storagePath: path, fileName, sizeBytes } })
})

router.post(
  '/:id/attachments',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { fileName, storagePath, quoteId } = z
      .object({
        fileName: z.string().min(1).max(255),
        storagePath: z.string().min(1),
        /** Whose paperwork it is. Absent means it belongs to the enquiry itself. */
        quoteId: z.string().optional().nullable(),
      })
      .parse(req.body)

    const enquiry = await prisma.purchaseEnquiry.findUnique({
      where: { id: req.params.id },
      select: { id: true, quotes: { select: { id: true } } },
    })
    if (!enquiry) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')

    if (quoteId && !enquiry.quotes.some((q) => q.id === quoteId)) {
      throw new AppError('That supplier is not on this enquiry', 400, 'WRONG_QUOTE')
    }
    if (!storagePath.startsWith('purchase-enquiries/' + enquiry.id + '/')) {
      throw new AppError('That file does not belong to this enquiry', 400, 'WRONG_DOCUMENT')
    }

    const { sizeBytes, mimeType } = await statObject(storagePath)
    if (sizeBytes > MAX_FILE_BYTES) {
      await removeObject(storagePath).catch(() => {})
      throw new AppError(
        'That file is ' +
          (sizeBytes / 1024 / 1024).toFixed(1) +
          'MB. The limit is ' +
          MAX_FILE_BYTES / 1024 / 1024 +
          'MB.',
        400,
        'FILE_TOO_LARGE'
      )
    }

    const attachment = await prisma.purchaseEnquiryAttachment.create({
      data: {
        enquiryId: enquiry.id,
        quoteId: quoteId || null,
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
      entityType: 'PurchaseEnquiryAttachment',
      entityId: attachment.id,
      after: attachment,
    })

    res.status(201).json({ success: true, data: attachment })
  }
)

router.get('/attachments/:id/link', requirePermission(MODULE, 'view'), async (req, res) => {
  const file = await prisma.purchaseEnquiryAttachment.findUnique({ where: { id: req.params.id } })
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
    const file = await prisma.purchaseEnquiryAttachment.findUnique({
      where: { id: req.params.id },
      include: attachmentInclude,
    })
    if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')

    await prisma.purchaseEnquiryAttachment.delete({ where: { id: file.id } })
    await removeObject(file.storagePath).catch(() => {})

    await writeAuditLog(req, {
      module: MODULE,
      action: 'DELETE',
      entityType: 'PurchaseEnquiryAttachment',
      entityId: file.id,
      before: file,
    })

    res.json({ success: true, message: file.fileName + ' removed.' })
  }
)

export default router
