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
  refuseIfOrdered,
  syncEnquiryStatus,
} from '../services/purchaseEnquiry.service'
import {
  closeEnquirySchema,
  createEnquirySchema,
  enquiryListQuerySchema,
  recordQuoteSchema,
  updateEnquirySchema,
} from '../schemas/enquiry.schemas'

/**
 * Purchase enquiries — the step between an indent and a purchase order.
 *
 * The mill's old ERP calls this a *provisional PO*. The buyer sends a supplier
 * quantities and, usually, no prices; he answers with a proforma invoice, his
 * own numbered document quoting a rate and saying how long he will hold it; and
 * the purchase order is raised against that PI's number.
 *
 * Mounted at `/api/purchase/enquiries` ahead of the purchase router, so it
 * inherits the same permission module and `/purchase/:id` never swallows these.
 *
 * -- Nothing here is a commitment ---------------------------------------------
 *
 * That is the entire reason the document exists, and it is the line this file is
 * careful not to cross. An enquiry does not reduce what an indent still needs
 * ordered, does not make goods receivable, does not appear in what a supplier is
 * owed, and does not move stock. The one number it contributes anywhere is a
 * figure on the indent list saying "600 of this is already out with a supplier"
 * — shown so the buyer does not enquire twice, and subtracted from nothing.
 *
 * -- Status is read, not written ----------------------------------------------
 *
 * DRAFT then SENT then QUOTED then ORDERED is derived from what exists: an order
 * standing on it, a PI recorded, a sent date. `syncEnquiryStatus` recomputes it,
 * so cancelling an order puts its quantity straight back on the enquiry with
 * nothing to remember to undo. CLOSED is the exception — a decision somebody
 * took, which survives until somebody reopens it.
 */

const MODULE = 'purchase'
const router = Router()

const round2 = (n: number) => Math.round(n * 100) / 100

const enquiryInclude = {
  supplier: {
    select: { id: true, code: true, name: true, gstin: true, stateCode: true, email: true },
  },
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
      mrLine: {
        select: {
          id: true,
          mr: { select: { id: true, mrNumber: true } },
        },
      },
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
  attachments: {
    orderBy: { createdAt: 'asc' },
    include: { uploadedBy: { select: { id: true, name: true } } },
  },
  purchaseOrders: {
    where: { deletedAt: null },
    orderBy: { poDate: 'desc' },
    select: { id: true, poNumber: true, poDate: true, status: true, totalAmount: true },
  },
} satisfies Prisma.PurchaseEnquiryInclude

const attachmentInclude = { uploadedBy: { select: { id: true, name: true } } }

/**
 * What the enquiry adds up to at the rates currently on it.
 *
 * Computed on the way out rather than stored. There is deliberately no
 * `totalAmount` column on this document: an enquiry's value is a moving estimate
 * until the PI arrives, and a stored total would be the one number on the screen
 * able to disagree with the lines under it. `piAmount` — the supplier's own
 * total, which does not move — is the figure that is stored.
 */
function valueOf(lines: Array<{ qty: unknown; quotedRate: unknown; expectedRate: unknown }>) {
  let quoted = 0
  let expected = 0
  let quotedLines = 0
  for (const l of lines) {
    const qty = Number(l.qty)
    const q = l.quotedRate == null ? null : Number(l.quotedRate)
    const e = l.expectedRate == null ? null : Number(l.expectedRate)
    if (q != null) {
      quoted += qty * q
      quotedLines++
    }
    if (e != null) expected += qty * e
  }
  return {
    quotedValue: round2(quoted),
    expectedValue: round2(expected),
    /** Lines the supplier has actually priced, so the screen can say "4 of 7". */
    quotedLines,
  }
}

/**
 * Whether the quoted price has run out.
 *
 * An ORDERED enquiry is never expired: the order was placed while the price
 * stood, and re-labelling it afterwards would be rewriting history. A CLOSED one
 * is not expired either — it is closed.
 */
function isExpired(piValidUntil: Date | null, status: string): boolean {
  if (!piValidUntil) return false
  if (status === 'ORDERED' || status === 'CLOSED') return false
  return piValidUntil.getTime() < Date.now()
}

/** The one definition of a quote that has lapsed, shared by filter and count. */
const EXPIRED_WHERE = (now: Date): Prisma.PurchaseEnquiryWhereInput => ({
  piValidUntil: { lt: now },
  status: { in: ['SENT', 'QUOTED'] },
})

// -- Reading -----------------------------------------------------------------

router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const q = enquiryListQuerySchema.parse(req.query)
  const now = new Date()

  const where: Prisma.PurchaseEnquiryWhereInput = {
    deletedAt: q.deleted ? { not: null } : null,
    ...(q.status ? { status: { in: q.status } } : {}),
    ...(q.supplierId ? { supplierId: q.supplierId } : {}),
    ...(q.itemId ? { lines: { some: { itemId: q.itemId } } } : {}),
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
            { piNumber: { contains: q.q, mode: 'insensitive' } },
            { remark: { contains: q.q, mode: 'insensitive' } },
            { supplier: { name: { contains: q.q, mode: 'insensitive' } } },
            { lines: { some: { item: { code: { contains: q.q, mode: 'insensitive' } } } } },
            { lines: { some: { item: { name: { contains: q.q, mode: 'insensitive' } } } } },
          ],
        }
      : {}),
  }

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
    prisma.purchaseEnquiry.count({ where: { ...summaryWhere, ...EXPIRED_WHERE(now) } }),
  ])

  res.json({
    success: true,
    data: rows.map((e) => ({
      ...e,
      ...valueOf(e.lines),
      expired: isExpired(e.piValidUntil, e.status),
    })),
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
 * Every supplier and item that has ever appeared on an enquiry.
 *
 * Registered before `/:id`, or Express reads "filter-options" as an id.
 *
 * Built from the whole table rather than from the page, which is the mistake the
 * receipts filters made: dropdowns assembled from the rows on screen offer
 * nothing on a page with nothing on it, and hide the very value somebody is
 * trying to filter down to.
 */
router.get('/filter-options', requirePermission(MODULE, 'view'), async (_req, res) => {
  const [suppliers, items] = await Promise.all([
    prisma.purchaseEnquiry.findMany({
      where: { deletedAt: null },
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
  ])

  res.json({
    success: true,
    data: { suppliers: suppliers.map((s) => s.supplier), items: items.map((i) => i.item) },
  })
})

router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const enquiry = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
    include: enquiryInclude,
  })
  if (!enquiry) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')

  const ordered = await orderedQtyByEnquiryLine(prisma, enquiry.id)

  res.json({
    success: true,
    data: {
      ...enquiry,
      ...valueOf(enquiry.lines),
      expired: isExpired(enquiry.piValidUntil, enquiry.status),
      lines: enquiry.lines.map((l) => ({
        ...l,
        orderedQty: ordered.get(l.id) ?? 0,
        pendingQty: round2(Math.max(0, Number(l.qty) - (ordered.get(l.id) ?? 0))),
      })),
    },
  })
})

router.get('/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const enquiry = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
    include: enquiryInclude,
  })
  if (!enquiry) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')

  const header = await getPrintHeader('ENQ')

  res.json({
    success: true,
    data: { ...header, enquiry: { ...enquiry, ...valueOf(enquiry.lines) } },
  })
})

// -- Writing -----------------------------------------------------------------

/**
 * Turns the submitted lines into rows, freezing what has to be frozen.
 *
 * The HSN is copied off the item rather than referenced, for the same reason a
 * purchase order copies it: an item's HSN gets corrected, and a document already
 * with a supplier must not change because of it.
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
    gstRate?: number | null
    mrLineId?: string | null
  }>
) {
  const items = await tx.item.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.itemId))] } },
    select: { id: true, code: true, hsnCode: true },
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
      gstRate: l.gstRate ?? null,
      mrLineId: l.mrLineId || null,
      sortOrder: i,
    }
  })
}

router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createEnquirySchema.parse(req.body)

  const supplier = await prisma.supplier.findUnique({
    where: { id: data.supplierId },
    select: { id: true, name: true, stateCode: true, gstin: true },
  })
  if (!supplier) throw new AppError('That supplier no longer exists', 400, 'BAD_SUPPLIER')

  const created = await prisma.$transaction(async (tx) => {
    const enquiryDate = data.enquiryDate ?? new Date()
    const enquiryNumber = await nextDocumentNumber(tx, 'ENQ', enquiryDate)

    return tx.purchaseEnquiry.create({
      data: {
        enquiryNumber,
        supplierId: data.supplierId,
        enquiryDate,
        requiredDate: data.requiredDate ?? null,
        /*
         * Falls back to the supplier's own state. An enquiry sent without a
         * place of supply cannot be read as CGST+SGST or IGST, and the buyer
         * comparing a quoted rate needs to know which it is before ordering,
         * not after the bill arrives.
         */
        placeOfSupplyCode:
          data.placeOfSupplyCode ?? supplier.stateCode ?? supplier.gstin?.slice(0, 2) ?? null,
        notes: data.notes ?? null,
        terms: data.terms ?? null,
        remark: data.remark ?? null,
        createdById: req.user!.id,
        lines: { create: await buildLines(tx, data.lines) },
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

  res.status(201).json({ success: true, data: created })
})

/**
 * Correcting an enquiry.
 *
 * Open while an order stands on it, narrowly. An enquiry for 1,240 with 600
 * ordered can have the other 640 corrected without touching that order —
 * refusing every edit would force cancelling a correct order to fix a typing
 * mistake unrelated to it, which is how corrections stop being made. What is
 * refused is only what would break: removing a line an order was raised from, or
 * cutting one below what has already been placed against it.
 *
 * Lines arrive whole and replace what is there, so an `id` on a submitted line
 * is what says "this is the same line" — without it, every save would look like
 * seven removals and seven additions, and the guard above would refuse the lot.
 */
router.patch('/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = updateEnquirySchema.parse(req.body)

  const before = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
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

  const enquiryId = before.id

  const updated = await prisma.$transaction(async (tx) => {
    if (data.lines) {
      await assertEditKeepsOrdersTrue(
        tx,
        before,
        data.lines.map((l) => ({ id: (l as { id?: string }).id ?? null, qty: l.qty }))
      )

      /*
       * Rates the supplier already quoted are carried across a correction.
       *
       * They belong to his PI, not to this form, so an edit that changes a
       * quantity must not silently drop the price he gave for it. Matched by
       * line id — a line added during the edit has no quoted rate, which is
       * right: he has not quoted it.
       */
      const quoted = new Map(
        before.lines.map((l) => [l.id, { quotedRate: l.quotedRate, gstRate: l.gstRate }])
      )
      const rows = await buildLines(tx, data.lines)

      await tx.purchaseEnquiryLine.deleteMany({ where: { enquiryId } })
      await tx.purchaseEnquiryLine.createMany({
        data: rows.map((r, i) => {
          const keep = quoted.get((data.lines![i] as { id?: string }).id ?? '')
          return {
            ...r,
            enquiryId,
            quotedRate: keep?.quotedRate ?? null,
            gstRate: r.gstRate ?? keep?.gstRate ?? null,
          }
        }),
      })
    }

    await tx.purchaseEnquiry.update({
      where: { id: enquiryId },
      data: {
        ...(data.supplierId !== undefined ? { supplierId: data.supplierId } : {}),
        ...(data.enquiryDate !== undefined ? { enquiryDate: data.enquiryDate } : {}),
        ...(data.requiredDate !== undefined ? { requiredDate: data.requiredDate ?? null } : {}),
        ...(data.placeOfSupplyCode !== undefined
          ? { placeOfSupplyCode: data.placeOfSupplyCode ?? null }
          : {}),
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

  res.json({ success: true, data: updated })
})

/**
 * Marking an enquiry as gone out.
 *
 * Stamps when, rather than flipping a flag, because the useful question later is
 * not whether it was sent but how long ago — a supplier who has had it for three
 * weeks is a different conversation from one who got it this morning.
 *
 * Idempotent. Pressing it twice does not move the date, or the mill would lose
 * the day it actually went out to the day somebody clicked again.
 */
router.patch('/:id/send', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const before = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
    select: { id: true, enquiryNumber: true, status: true, sentAt: true, deletedAt: true },
  })
  if (!before) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')
  if (before.deletedAt) {
    throw new AppError(before.enquiryNumber + ' is in the recycle bin.', 409, 'DELETED')
  }
  if (before.status === 'CLOSED') {
    throw new AppError(
      before.enquiryNumber + ' is closed. Reopen it before sending.',
      409,
      'ENQUIRY_CLOSED'
    )
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (!before.sentAt) {
      await tx.purchaseEnquiry.update({ where: { id: before.id }, data: { sentAt: new Date() } })
    }
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
    data: updated,
    message: before.sentAt
      ? before.enquiryNumber + ' was already marked sent.'
      : before.enquiryNumber + ' marked as sent to the supplier.',
  })
})

/**
 * Recording the supplier's proforma invoice.
 *
 * Allowed from DRAFT as well as SENT, and stamps the sent date if it is missing.
 * Plenty of enquiries are made by phone and confirmed by a PI arriving an hour
 * later, and refusing to record his document because nobody pressed Send first
 * would push the step back onto email — which is exactly where it was.
 *
 * Re-recordable. A revised PI against the same enquiry is ordinary: he quotes,
 * the buyer pushes back, he sends a second one. The latest is what stands, and
 * the audit log holds the ones before it.
 *
 * His total is stored as he stated it and is not reconciled against the rates.
 * Where the two disagree the screen says so; it does not pick a winner.
 */
router.patch('/:id/quote', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = recordQuoteSchema.parse(req.body)

  const before = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
    include: enquiryInclude,
  })
  if (!before) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')
  if (before.deletedAt) {
    throw new AppError(before.enquiryNumber + ' is in the recycle bin.', 409, 'DELETED')
  }
  if (before.status === 'CLOSED') {
    throw new AppError(
      before.enquiryNumber + ' is closed. Reopen it before recording a quote.',
      409,
      'ENQUIRY_CLOSED'
    )
  }
  if (data.validUntil && data.validUntil < data.piDate) {
    throw new AppError(
      'The PI cannot expire before the date on it. Check the validity.',
      400,
      'BAD_VALIDITY'
    )
  }

  const mine = new Set(before.lines.map((l) => l.id))
  for (const r of data.rates ?? []) {
    if (!mine.has(r.lineId)) {
      throw new AppError(
        'One of those rates is against a line that is not on this enquiry',
        400,
        'WRONG_LINE'
      )
    }
  }

  const enquiryId = before.id

  const updated = await prisma.$transaction(async (tx) => {
    for (const r of data.rates ?? []) {
      await tx.purchaseEnquiryLine.update({
        where: { id: r.lineId },
        data: {
          ...(r.quotedRate !== undefined ? { quotedRate: r.quotedRate ?? null } : {}),
          ...(r.gstRate !== undefined ? { gstRate: r.gstRate ?? null } : {}),
        },
      })
    }

    await tx.purchaseEnquiry.update({
      where: { id: enquiryId },
      data: {
        piNumber: data.piNumber,
        piDate: data.piDate,
        piAmount: data.amount ?? null,
        piValidUntil: data.validUntil ?? null,
        piReceivedAt: new Date(),
        ...(before.sentAt ? {} : { sentAt: data.piDate }),
        ...(data.remark ? { remark: data.remark } : {}),
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

  res.json({
    success: true,
    data: updated,
    message: 'PI ' + data.piNumber + ' recorded against ' + before.enquiryNumber + '.',
  })
})

/**
 * Dropping an enquiry, with the reason on the record.
 *
 * Refused while a live order stands on it: that order carries this enquiry's PI
 * number as the reference its price is defended with, and closing the enquiry
 * underneath it leaves the order quoting a document nobody will look at again.
 */
router.patch('/:id/close', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = closeEnquirySchema.parse(req.body)

  const before = await prisma.purchaseEnquiry.findUnique({
    where: { id: req.params.id },
    select: { id: true, enquiryNumber: true, status: true, deletedAt: true, closeReason: true },
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

  res.json({ success: true, data: updated, message: before.enquiryNumber + ' closed.' })
})

/**
 * Reopening a closed enquiry.
 *
 * The status it lands on is worked out from what is on it, not from what it was
 * before — a supplier who answers three weeks after the buyer gave up reopens
 * into QUOTED, because the PI is there.
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
    data: updated,
    message: before.enquiryNumber + ' reopened as ' + updated.status.toLowerCase() + '.',
  })
})

/**
 * Into the recycle bin, not out of existence.
 *
 * Marked and passed over, the same as a purchase order: the enquiry number is
 * burnt either way — the mill never reuses a document number — so destroying the
 * row would leave a gap in the series that nobody can account for. A binned
 * enquiry can be put back whole.
 *
 * Refused while a live order stands on it, for the reason `refuseIfOrdered` gives.
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

  res.json({ success: true, data: updated, message: before.enquiryNumber + ' restored.' })
})

// -- Files -------------------------------------------------------------------
//
// The supplier's PI arrives as a PDF or a photograph, and it is the document the
// order's price is defended with when the bill is queried months later. Uploads
// go straight to storage on a signed URL and the row is written afterwards, so a
// file that never finished uploading leaves no attachment claiming it did.

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
    const { fileName, storagePath } = z
      .object({ fileName: z.string().min(1).max(255), storagePath: z.string().min(1) })
      .parse(req.body)

    const enquiry = await prisma.purchaseEnquiry.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    })
    if (!enquiry) throw new AppError('That enquiry no longer exists', 404, 'NOT_FOUND')

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
