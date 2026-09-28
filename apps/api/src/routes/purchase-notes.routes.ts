import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { amountInWords, getPrintHeader } from '../lib/printData'
import { nextDocumentNumber } from '../lib/docNumber'
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
  adjustableOn,
  adjustableOnGrn,
  assertEditable,
  assertIssuerMatches,
  DOC_RULES,
  effectFor,
  GST_TREATMENTS,
  moveNoteStock,
  priceNote,
  REASON_RULES,
  syncBillAdjustments,
  taxContextFor,
  TRANSITIONS,
  type NoteLineInput,
} from '../services/purchaseNote.service'
import {
  createNoteSchema,
  gstTreatmentSchema,
  noteListQuerySchema,
  updateNoteSchema,
} from '../schemas/purchase-note.schemas'

/**
 * Adjustments against a supplier's bill, of every kind.
 *
 * Our own claim, their credit note, their debit note. One router for all of
 * them: they point at the same bill, validate against the same remaining
 * balance and print on the same sheet, so splitting them would have been
 * three of every route below, drifting apart from the first change onwards.
 * `docType`, `issuedBy` and `effect` are filters on the list and fields on the
 * form; everything else is shared.
 *
 * ── Three questions, not one ────────────────────────────────────────────────
 *
 * The purchase office answers exactly one of them: what happened in the
 * godown. It does NOT decide what document results, who issues it, or what
 * GST makes of it, and this router is careful never to infer any of those
 * from the first. An adjustment does not have a direction because of the
 * event behind it — it has one because of the document, which is why
 * `effectFor` is keyed on `docType` and nothing anywhere reads a direction off
 * a reason.
 *
 * Mounted at `/api/purchase/notes` ahead of the purchase router, so it
 * inherits the same permission module and the `/purchase/:id` routes there
 * never swallow these.
 *
 * ── What is deliberately not automatic ──────────────────────────────────────
 *
 * Nothing here decides on its own that money should move. A note is saved as a
 * draft, submitted by the buyer, approved by somebody else and posted by
 * accounts — four separate presses, because the last one changes what a
 * supplier is owed and the mill's own rules forbid the person who raised a
 * document from approving it.
 */

const MODULE = 'purchase'
const router = Router()

const round2 = (n: number) => Math.round(n * 100) / 100

const noteInclude = {
  supplier: {
    select: { id: true, code: true, name: true, gstin: true, stateCode: true },
  },
  bill: {
    select: {
      id: true,
      billNumber: true,
      supplierInvoiceNo: true,
      supplierInvoiceDate: true,
      billDate: true,
      totalAmount: true,
      balanceAmount: true,
      noteAdjustment: true,
      status: true,
    },
  },
  po: { select: { id: true, poNumber: true, poDate: true } },
  grn: { select: { id: true, grnNumber: true, grnDate: true } },
  purchaseReturn: {
    select: { id: true, returnNumber: true, status: true, returnDate: true },
  },
  warehouse: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  submittedBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  postedBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    select: {
      id: true,
      description: true,
      hsnCode: true,
      originalQty: true,
      originalRate: true,
      qty: true,
      unitPrice: true,
      taxableValue: true,
      gstRate: true,
      cgst: true,
      sgst: true,
      igst: true,
      amount: true,
      remarks: true,
      billLineId: true,
      grnLineId: true,
      item: {
        select: { id: true, code: true, name: true, uom: { select: { symbol: true } } },
      },
    },
  },
  attachments: {
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      createdAt: true,
      uploadedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.PurchaseNoteInclude

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Everything the form's three questions are built from.
 *
 * Served rather than duplicated in the web app, so the wording a buyer reads
 * and the rule the server enforces cannot drift apart — and served as three
 * separate lists, because that is what they are. `commonly` is the document
 * the form pre-selects for a reason, and the form labels it as a suggestion:
 * it exists so the ordinary case needs no thought, not so the unusual case
 * gets waved through as the ordinary one.
 */
router.get('/reasons', requirePermission(MODULE, 'view'), (_req, res) => {
  res.json({
    success: true,
    data: {
      /** What happened. An event. Carries no direction and no document. */
      reasons: Object.entries(REASON_RULES).map(([value, r]) => ({
        value,
        label: r.label,
        hint: r.hint,
        movesGoods: r.movesGoods,
        consumesQty: r.consumesQty,
        commonly: r.commonly,
      })),
      /** What kind of document resulted. This is what sets the direction. */
      docTypes: Object.entries(DOC_RULES).map(([value, d]) => ({
        value,
        label: d.label,
        hint: d.hint,
        issuedBy: d.issuedBy,
        /** Null means the direction is a choice, not a definition. */
        effect: d.effect,
        needsSupplierDoc: d.needsSupplierDoc,
      })),
      /** How the accounts desk classifies it. Read-only to the purchase office. */
      gstTreatments: Object.entries(GST_TREATMENTS).map(([value, g]) => ({
        value,
        label: g.label,
        hint: g.hint,
      })),
    },
  })
})

router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const q = noteListQuerySchema.parse(req.query)

  const where: Prisma.PurchaseNoteWhereInput = {
    ...(q.docType ? { docType: { in: q.docType } } : {}),
    ...(q.issuedBy ? { issuedBy: q.issuedBy } : {}),
    ...(q.effect ? { effect: q.effect } : {}),
    ...(q.gstTreatment ? { gstTreatment: q.gstTreatment } : {}),
    ...(q.status ? { status: { in: q.status } } : {}),
    ...(q.reason ? { reason: q.reason } : {}),
    ...(q.supplierId ? { supplierId: q.supplierId } : {}),
    ...(q.billId ? { billId: q.billId } : {}),
    ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}),
    // Inclusive at both ends — `to` read as midnight silently drops everything
    // raised that afternoon.
    ...(q.from || q.to
      ? {
          noteDate: {
            ...(q.from ? { gte: new Date(`${q.from}T00:00:00`) } : {}),
            ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999`) } : {}),
          },
        }
      : {}),
    ...(q.q
      ? {
          OR: [
            { noteNumber: { contains: q.q, mode: 'insensitive' } },
            { supplierDocNo: { contains: q.q, mode: 'insensitive' } },
            { reasonNote: { contains: q.q, mode: 'insensitive' } },
            { supplier: { name: { contains: q.q, mode: 'insensitive' } } },
            { bill: { billNumber: { contains: q.q, mode: 'insensitive' } } },
            { bill: { supplierInvoiceNo: { contains: q.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }

  // The cards describe the same filter as the table, minus the status the user
  // is looking at — a count that ignored the supplier filter would contradict
  // the rows underneath it.
  const summaryWhere: Prisma.PurchaseNoteWhereInput = { ...where, status: undefined }

  /*
   * How many notes accounts has not yet classified for GST.
   *
   * Counted here rather than off the page. The screen used to filter the rows
   * it had been sent, which made the figure quietly mean "on this page" — true
   * while there was one page and wrong the moment there were two. It is a card
   * the user can now press to narrow the list, and a card whose number does
   * not match the rows pressing it produces is worse than no card at all.
   *
   * A cancelled note is left out for the same reason it is on screen: nothing
   * is owed on it, so nobody has to classify it.
   */
  const unclassifiedWhere: Prisma.PurchaseNoteWhereInput = {
    ...summaryWhere,
    gstTreatment: 'NOT_REVIEWED',
    status: { not: 'CANCELLED' },
  }

  const [rows, total, summary, unclassified] = await Promise.all([
    prisma.purchaseNote.findMany({
      where,
      include: noteInclude,
      orderBy: [{ noteDate: 'desc' }, { noteNumber: 'desc' }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.purchaseNote.count({ where }),
    prisma.purchaseNote.groupBy({
      by: ['status'],
      where: summaryWhere,
      _sum: { totalAmount: true },
      _count: { _all: true },
    }),
    prisma.purchaseNote.aggregate({
      where: unclassifiedWhere,
      _sum: { totalAmount: true },
      _count: { _all: true },
    }),
  ])

  res.json({
    success: true,
    data: rows,
    unclassified: {
      count: unclassified._count._all,
      amount: round2(Number(unclassified._sum.totalAmount ?? 0)),
    },
    summary: Object.fromEntries(
      summary.map((s) => [
        s.status,
        { count: s._count._all, amount: round2(Number(s._sum.totalAmount ?? 0)) },
      ])
    ),
    pagination: {
      page: q.page,
      limit: q.limit,
      total,
      pages: Math.max(1, Math.ceil(total / q.limit)),
    },
  })
})

/**
 * What a bill still has left to adjust, line by line.
 *
 * Asked by the form before anything is typed, so the buyer sees "70 left of
 * 100" in the row rather than finding out at save time that 30 went on a note
 * somebody else raised last week.
 */
router.get('/adjustable/:billId', requirePermission(MODULE, 'view'), async (req, res) => {
  const exclude = typeof req.query.exclude === 'string' ? req.query.exclude : undefined

  const [bill, lines] = await prisma.$transaction(async (tx) => [
    await tx.purchaseInvoice.findUnique({
      where: { id: req.params.billId },
      select: {
        id: true,
        billNumber: true,
        supplierInvoiceNo: true,
        supplierInvoiceDate: true,
        billDate: true,
        totalAmount: true,
        paidAmount: true,
        noteAdjustment: true,
        balanceAmount: true,
        status: true,
        igst: true,
        cgst: true,
        supplier: { select: { id: true, code: true, name: true, gstin: true } },
        po: { select: { id: true, poNumber: true } },
        lines: {
          select: { grnLine: { select: { grn: { select: { id: true, grnNumber: true } } } } },
        },
      },
    }),
    await adjustableOn(tx, req.params.billId, exclude),
  ])

  if (!bill) throw new AppError('That purchase bill no longer exists', 404, 'NOT_FOUND')

  const receipts = [
    ...new Map(
      bill.lines
        .map((l) => l.grnLine?.grn)
        .filter((g): g is { id: string; grnNumber: string } => Boolean(g))
        .map((g) => [g.id, g])
    ).values(),
  ]

  res.json({
    success: true,
    data: {
      bill: { ...bill, lines: undefined, receipts },
      isIntraState: Number(bill.igst) <= 0,
      lines,
    },
  })
})

/**
 * What a receipt still has left to note, line by line — for a note raised
 * with no bill behind it.
 *
 * The counterpart to `/adjustable/:billId`. Goods rejected at the gate never
 * get billed, so a bill has nothing to offer a note against them; this is
 * what the "Raise a note" action on the goods-receipt screen reads before a
 * line is typed, the same way the bill form reads the other route first.
 */
router.get('/from-grn/:grnId', requirePermission(MODULE, 'view'), async (req, res) => {
  const exclude = typeof req.query.exclude === 'string' ? req.query.exclude : undefined

  const [grn, matched] = await prisma.$transaction(async (tx) => [
    await tx.gRN.findUnique({
      where: { id: req.params.grnId },
      select: {
        id: true,
        grnNumber: true,
        status: true,
        po: {
          select: {
            id: true,
            poNumber: true,
            supplier: { select: { id: true, code: true, name: true, gstin: true } },
          },
        },
      },
    }),
    await adjustableOnGrn(tx, req.params.grnId, exclude),
  ])

  if (!grn) throw new AppError('That goods receipt no longer exists', 404, 'NOT_FOUND')
  if (!grn.po)
    throw new AppError(
      'The order this receipt was raised against no longer exists',
      404,
      'NOT_FOUND'
    )

  res.json({
    success: true,
    data: {
      grn: { id: grn.id, grnNumber: grn.grnNumber, status: grn.status },
      po: grn.po,
      lines: matched.lines,
    },
  })
})

router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const note = await prisma.purchaseNote.findUnique({
    where: { id: req.params.id },
    include: noteInclude,
  })
  if (!note) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
  res.json({ success: true, data: note })
})

router.get('/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const note = await prisma.purchaseNote.findUnique({
    where: { id: req.params.id },
    include: noteInclude,
  })
  if (!note) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')

  const header = await getPrintHeader(DOC_RULES[note.docType].series)

  res.json({
    success: true,
    data: {
      ...header,
      note,
      reasonLabel: REASON_RULES[note.reason].label,
      docLabel: DOC_RULES[note.docType].label,
      gstLabel: GST_TREATMENTS[note.gstTreatment].label,
      totalInWords: amountInWords(Number(note.totalAmount)),
      taxMode: Number(note.igst) > 0 ? 'IGST' : Number(note.cgst) > 0 ? 'CGST_SGST' : 'NONE',
    },
  })
})

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Checks the lines against what the bill has left, and says which line is
 * wrong when one is.
 *
 * Both ceilings are tested. Quantity stops the same hundred metres being
 * returned twice; value stops a line being claimed back for more than it was
 * ever charged, which a quantity check alone lets through as soon as somebody
 * types a rate the bill never carried. Several notes may stand against one
 * bill — `adjustableOn` sums every one of them that is still alive, so the
 * ceiling is on the running total and not on any single note.
 *
 * Only reductions are capped. An adjustment that INCREASES the invoice is not
 * bounded by what the invoice charged — a supplier billing for replacements
 * they shipped is adding to it, and the eligible balance grows rather than
 * shrinks. Testing an increase against "what is left to reduce" would refuse
 * it for being larger than a number it has nothing to do with.
 */
async function assertWithinBill(
  tx: Prisma.TransactionClient,
  opts: {
    billId: string
    reason: keyof typeof REASON_RULES
    effect: 'REDUCES_PAYABLE' | 'INCREASES_PAYABLE'
    lines: NoteLineInput[]
    pricedLines: Array<{ taxableValue: number }>
    excludeNoteId?: string
  }
): Promise<void> {
  const available = await adjustableOn(tx, opts.billId, opts.excludeNoteId)
  const byId = new Map(available.map((a) => [a.billLineId, a]))
  const consumesQty = REASON_RULES[opts.reason].consumesQty
  const reduces = opts.effect === 'REDUCES_PAYABLE'

  // Several note lines may point at the same bill line; they have to be added
  // up before either ceiling is tested, or two half-claims each pass.
  const wantedQty = new Map<string, number>()
  const wantedValue = new Map<string, number>()
  opts.lines.forEach((l, i) => {
    if (!l.billLineId) return
    wantedQty.set(l.billLineId, (wantedQty.get(l.billLineId) ?? 0) + l.qty)
    wantedValue.set(
      l.billLineId,
      (wantedValue.get(l.billLineId) ?? 0) + opts.pricedLines[i].taxableValue
    )
  })

  for (const [billLineId, qty] of wantedQty) {
    const line = byId.get(billLineId)
    if (!line) {
      throw new AppError(
        'One of these lines is against a bill line that is no longer there. Reopen the bill and pick the lines again.',
        409,
        'BILL_LINE_GONE'
      )
    }

    if (reduces && consumesQty && qty > line.remainingQty + 0.0005) {
      const unit = line.uom ? ` ${line.uom}` : ''
      throw new AppError(
        `Only ${line.remainingQty}${unit} of ${line.itemName} can still be adjusted against this bill` +
          (line.adjustedQty > 0
            ? ` — ${line.billedQty}${unit} was billed and ${line.adjustedQty}${unit} is already on other notes.`
            : '.') +
          ` You have entered ${qty}${unit}.`,
        400,
        'OVER_ADJUSTED'
      )
    }

    const value = round2(wantedValue.get(billLineId) ?? 0)
    if (reduces && value > line.remainingValue + 0.005) {
      throw new AppError(
        `${line.itemName} was charged ₹${line.billedTaxable.toLocaleString('en-IN')} on this bill and ` +
          `₹${line.remainingValue.toLocaleString('en-IN')} of that is still adjustable. ` +
          `This note claims ₹${value.toLocaleString('en-IN')} against it.`,
        400,
        'OVER_ADJUSTED_VALUE'
      )
    }
  }
}

/**
 * The supplier a receipt was received against, for a note raised off it with
 * no bill behind it — the same derivation as `supplierId = bill.supplierId`
 * below, for the other document a note can be anchored to.
 */
async function supplierFromGrn(tx: Prisma.TransactionClient, grnId: string): Promise<string> {
  const grn = await tx.gRN.findUnique({
    where: { id: grnId },
    select: { po: { select: { supplierId: true } } },
  })
  if (!grn?.po) {
    throw new AppError('That goods receipt no longer exists', 404, 'NOT_FOUND')
  }
  return grn.po.supplierId
}

router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createNoteSchema.parse(req.body)

  const note = await prisma.$transaction(async (tx) => {
    // The supplier comes from the bill when there is one, and from the
    // receipt when there is not — a note whose supplier disagrees with the
    // document it adjusts is a note that reduces the wrong party's payable,
    // so it is derived and not taken on trust either way.
    let supplierId = data.supplierId
    if (data.billId) {
      const bill = await tx.purchaseInvoice.findUnique({
        where: { id: data.billId },
        select: { id: true, supplierId: true, billNumber: true, status: true },
      })
      if (!bill) throw new AppError('That purchase bill no longer exists', 404, 'NOT_FOUND')
      if (bill.status === 'CANCELLED') {
        throw new AppError(
          `${bill.billNumber} is cancelled. There is nothing left on it to adjust.`,
          400,
          'BILL_CANCELLED'
        )
      }
      supplierId = bill.supplierId
    } else if (data.grnId) {
      supplierId = await supplierFromGrn(tx, data.grnId)
    }

    const isIntraState = await taxContextFor(tx, supplierId, data.billId)
    const priced = priceNote({
      lines: data.lines,
      isIntraState,
      otherCharges: data.otherCharges,
      discountAmount: data.discountAmount,
    })

    if (priced.totalAmount <= 0) {
      throw new AppError(
        'This note comes to nothing. Enter a quantity and a rate on at least one line.',
        400,
        'NOTHING_CLAIMED'
      )
    }

    /* The direction comes from the document, never from the event. For
       every kind but OTHER it is a definition and `data.effect` is ignored;
       for OTHER it is the explicit choice the form was made to ask for. */
    assertIssuerMatches(data.docType, data.issuedBy)
    const effect = effectFor(data.docType, data.effect ?? null)

    if (data.billId) {
      await assertWithinBill(tx, {
        billId: data.billId,
        reason: data.reason,
        effect,
        lines: data.lines,
        pricedLines: priced.lines,
      })
    }

    /* Each kind draws from its own series. Sharing one between our claims and
       the supplier's documents would put holes in a run that has to be
       unbroken, and make "DN-2627-0007" ambiguous about whose it is. */
    const noteNumber = await nextDocumentNumber(tx, DOC_RULES[data.docType].series, data.noteDate)

    return tx.purchaseNote.create({
      data: {
        noteNumber,
        reason: data.reason,
        reasonNote: data.reasonNote ?? null,
        issuedBy: data.issuedBy,
        docType: data.docType,
        effect,
        supplierId,
        billId: data.billId ?? null,
        withoutBillReason: data.billId ? null : (data.withoutBillReason ?? null),
        poId: data.poId ?? null,
        grnId: data.grnId ?? null,
        noteDate: data.noteDate,
        supplierDocNo: data.supplierDocNo ?? null,
        supplierDocDate: data.supplierDocDate ?? null,
        warehouseId: data.warehouseId ?? null,
        lrNumber: data.lrNumber ?? null,
        vehicleNo: data.vehicleNo ?? null,
        otherRef: data.otherRef ?? null,
        isIntraState,
        taxableAmount: priced.taxableAmount,
        discountAmount: priced.discountAmount,
        cgst: priced.cgst,
        sgst: priced.sgst,
        igst: priced.igst,
        otherCharges: priced.otherCharges,
        roundOff: priced.roundOff,
        totalAmount: priced.totalAmount,
        notes: data.notes ?? null,
        createdById: req.user!.id,
        lines: {
          create: priced.lines.map((l, i) => ({
            itemId: l.itemId,
            billLineId: l.billLineId ?? null,
            grnLineId: l.grnLineId ?? null,
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
            remarks: l.remarks ?? null,
            sortOrder: i,
          })),
        },
      },
      include: noteInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'PurchaseNote',
    entityId: note.id,
    after: note,
  })

  res.status(201).json({
    success: true,
    data: note,
    message: `${note.noteNumber} saved as a draft. Post it when you are ready.`,
  })
})

router.patch('/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = updateNoteSchema.parse(req.body)

  const note = await prisma.$transaction(async (tx) => {
    const before = await tx.purchaseNote.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        noteNumber: true,
        status: true,
        docType: true,
        supplierId: true,
        billId: true,
        purchaseReturn: {
          select: {
            returnNumber: true,
            lines: { select: { billLineId: true, qty: true } },
          },
        },
      },
    })
    if (!before) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
    assertEditable(before.status, before.noteNumber)

    /*
     * A note raised from a return challan prices goods that have already left.
     *
     * The rate, the GST treatment and the wording are accounts' to settle — a
     * supplier who accepts the return at a lower rate than he billed is common
     * — but what went back, and how much of it, is what the gate pass says.
     * A note that quietly claimed for eighty rolls against a challan for a
     * hundred would leave twenty gone from stock and never charged back.
     */
    if (before.purchaseReturn) {
      const want = new Map<string, number>()
      for (const l of before.purchaseReturn.lines) {
        want.set(l.billLineId, (want.get(l.billLineId) ?? 0) + Number(l.qty))
      }
      const got = new Map<string, number>()
      for (const l of data.lines) {
        if (!l.billLineId) continue
        got.set(l.billLineId, (got.get(l.billLineId) ?? 0) + Number(l.qty))
      }
      const same =
        data.billId === before.billId &&
        data.lines.every((l) => Boolean(l.billLineId)) &&
        want.size === got.size &&
        [...want].every(([id, q]) => Math.abs((got.get(id) ?? -1) - q) < 0.0005)
      if (!same) {
        throw new AppError(
          `${before.noteNumber} was raised from return challan ${before.purchaseReturn.returnNumber}, so its items and quantities are the ones that challan sent back. Change the rate or the GST here; to change what went back, cancel the challan and write a new one.`,
          409,
          'NOTE_FROM_RETURN'
        )
      }
    }

    assertIssuerMatches(data.docType, data.issuedBy)
    const effect = effectFor(data.docType, data.effect ?? null)

    let supplierId = data.supplierId
    if (data.billId) {
      const bill = await tx.purchaseInvoice.findUnique({
        where: { id: data.billId },
        select: { supplierId: true, billNumber: true, status: true },
      })
      if (!bill) throw new AppError('That purchase bill no longer exists', 404, 'NOT_FOUND')
      if (bill.status === 'CANCELLED') {
        throw new AppError(
          `${bill.billNumber} is cancelled. There is nothing left on it to adjust.`,
          400,
          'BILL_CANCELLED'
        )
      }
      supplierId = bill.supplierId
    } else if (data.grnId) {
      supplierId = await supplierFromGrn(tx, data.grnId)
    }

    const isIntraState = await taxContextFor(tx, supplierId, data.billId)
    const priced = priceNote({
      lines: data.lines,
      isIntraState,
      otherCharges: data.otherCharges,
      discountAmount: data.discountAmount,
    })

    if (priced.totalAmount <= 0) {
      throw new AppError(
        'This note comes to nothing. Enter a quantity and a rate on at least one line.',
        400,
        'NOTHING_CLAIMED'
      )
    }

    if (data.billId) {
      await assertWithinBill(tx, {
        billId: data.billId,
        reason: data.reason,
        effect,
        lines: data.lines,
        pricedLines: priced.lines,
        excludeNoteId: before.id,
      })
    }

    // Replaced rather than diffed. A note is a handful of lines edited whole on
    // one form, and matching them up by id would be more code to go wrong than
    // the write it saves — the same choice the bill form already made.
    await tx.purchaseNoteLine.deleteMany({ where: { noteId: before.id } })

    return tx.purchaseNote.update({
      where: { id: before.id },
      data: {
        reason: data.reason,
        reasonNote: data.reasonNote ?? null,
        issuedBy: data.issuedBy,
        docType: data.docType,
        effect,
        supplierId,
        billId: data.billId ?? null,
        withoutBillReason: data.billId ? null : (data.withoutBillReason ?? null),
        poId: data.poId ?? null,
        grnId: data.grnId ?? null,
        noteDate: data.noteDate,
        supplierDocNo: data.supplierDocNo ?? null,
        supplierDocDate: data.supplierDocDate ?? null,
        warehouseId: data.warehouseId ?? null,
        lrNumber: data.lrNumber ?? null,
        vehicleNo: data.vehicleNo ?? null,
        otherRef: data.otherRef ?? null,
        isIntraState,
        taxableAmount: priced.taxableAmount,
        discountAmount: priced.discountAmount,
        cgst: priced.cgst,
        sgst: priced.sgst,
        igst: priced.igst,
        otherCharges: priced.otherCharges,
        roundOff: priced.roundOff,
        totalAmount: priced.totalAmount,
        notes: data.notes ?? null,
        lines: {
          create: priced.lines.map((l, i) => ({
            itemId: l.itemId,
            billLineId: l.billLineId ?? null,
            grnLineId: l.grnLineId ?? null,
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
            remarks: l.remarks ?? null,
            sortOrder: i,
          })),
        },
      },
      include: noteInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseNote',
    entityId: note.id,
    after: note,
  })

  res.json({ success: true, data: note, message: `${note.noteNumber} saved.` })
})

// ── The workflow ────────────────────────────────────────────────────────────

const reasonBody = z.object({ reason: z.string().trim().max(500).optional() })

/** Guards one step and says plainly why it is refused. */
function assertTransition(from: string, to: string, noteNumber: string): void {
  if (!TRANSITIONS[from]?.next.includes(to)) {
    throw new AppError(
      `${noteNumber} is ${from.toLowerCase()} and cannot be ${to.toLowerCase()} from there.`,
      409,
      'BAD_TRANSITION'
    )
  }
}

router.post('/:id/post', requirePermission(MODULE, 'post'), async (req: AuthRequest, res) => {
  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.purchaseNote.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        noteNumber: true,
        status: true,
        reason: true,
        effect: true,
        docType: true,
        gstTreatment: true,
        warehouseId: true,
        noteDate: true,
        billId: true,
        returnId: true,
        lines: { select: { itemId: true, qty: true, unitPrice: true } },
      },
    })
    if (!before) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
    assertTransition(before.status, 'POSTED', before.noteNumber)

    /*
     * An unclassified note posts, and says so.
     *
     * This was a hard block. It was the same jam the approval step had been,
     * moved one press later: money the mill had genuinely agreed sat unposted
     * waiting on a classification nobody was chasing. Blocking also puts the
     * accounts desk on the critical path of every small adjustment, which is
     * not where they asked to be.
     *
     * The separation the model exists for is kept by making the gap visible
     * rather than impassable — the note carries NOT_REVIEWED, the list shows
     * it amber, and the message below says it out loud at the moment of
     * posting. What is NOT done is quietly deciding a treatment on the
     * purchase office's behalf, which is the one outcome worth preventing.
     */
    const unclassified = before.gstTreatment === 'NOT_REVIEWED'

    const moved = await moveNoteStock(tx, before, 'POST')

    await tx.purchaseNote.update({
      where: { id: before.id },
      data: { status: 'POSTED', postedById: req.user!.id, postedAt: new Date() },
    })

    if (before.billId) await syncBillAdjustments(tx, before.billId)

    // Read back AFTER the bill has been resynced, not before. Reading it with
    // the update returned the balance as it stood a moment earlier, so the
    // message told the clerk who had just moved the money that nothing had
    // changed — the database was right and the sentence was wrong, which is
    // the harder of the two to notice.
    const note = await tx.purchaseNote.findUniqueOrThrow({
      where: { id: before.id },
      include: noteInclude,
    })

    return { note, moved, unclassified }
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseNote',
    entityId: result.note.id,
    after: result.note,
  })

  const bill = result.note.bill
  res.json({
    success: true,
    data: result.note,
    message:
      `${result.note.noteNumber} posted.` +
      (bill
        ? ` ${bill.billNumber} now stands at ₹${Number(bill.balanceAmount).toLocaleString('en-IN')}.`
        : '') +
      (result.moved
        ? ` ${result.moved} line${result.moved === 1 ? '' : 's'} moved in stock.`
        : '') +
      /* Said at the moment it matters, not swallowed. The note is through and
         the money has moved; what has NOT happened is anybody deciding what
         this is for GST, and the person who just pressed the button is the
         one who can go and ask. */
      (result.unclassified ? ' Accounts has not classified it for GST yet.' : ''),
  })
})

/**
 * Cancels it, reversing a posted one.
 *
 * A posted note is not deleted and not quietly unposted: the goods go back on
 * the rack as their own movement and the payable is recomputed, so the ledger
 * shows both that the mill returned the cloth and that it took it back. The
 * same shape as reversing a supplier payment, which is the pattern this
 * codebase already settled on for undoing something that moved money.
 */
/**
 * The accounts desk says what this is for GST. Nobody else may.
 *
 * Gated on `purchase:post` rather than on a new action, because it is the
 * same desk and the same decision: whoever puts a note through the books is
 * the person who has to have classified it, and the post route refuses any
 * note still sitting at NOT_REVIEWED.
 *
 * Deliberately its own route and not a field on the note form. Folded into
 * the note, it becomes a dropdown a purchase clerk sees and fills in, and the
 * separation this whole module was re-cut for would last about a week.
 *
 * Allowed on a posted note as well as a draft. A misclassification found
 * after posting is corrected by correcting it — the alternative is cancelling
 * a note that is correct in every other respect and burning a document number
 * to fix a label.
 */
router.patch(
  '/:id/gst-treatment',
  requirePermission(MODULE, 'post'),
  async (req: AuthRequest, res) => {
    const data = gstTreatmentSchema.parse(req.body)

    const before = await prisma.purchaseNote.findUnique({
      where: { id: req.params.id },
      select: { id: true, noteNumber: true, status: true, gstTreatment: true },
    })
    if (!before) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
    if (before.status === 'CANCELLED') {
      throw new AppError(
        `${before.noteNumber} is cancelled. There is nothing left on it to classify.`,
        409,
        'NOTE_CANCELLED'
      )
    }

    const note = await prisma.purchaseNote.update({
      where: { id: before.id },
      data: {
        gstTreatment: data.gstTreatment,
        gstNote: data.gstNote ?? null,
        gstTreatedById: req.user!.id,
        gstTreatedAt: new Date(),
      },
      include: noteInclude,
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'PurchaseNote',
      entityId: note.id,
      before,
      after: note,
    })

    res.json({
      success: true,
      data: note,
      message: `${note.noteNumber} classified as ${GST_TREATMENTS[data.gstTreatment].label}.`,
    })
  }
)

router.post('/:id/cancel', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonBody.parse(req.body ?? {})

  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.purchaseNote.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        noteNumber: true,
        status: true,
        reason: true,
        // Reversing a movement needs to know which way it went. Without this
        // the reversal of a supplier debit note's goods-in would itself have
        // been a goods-in.
        effect: true,
        warehouseId: true,
        noteDate: true,
        billId: true,
        returnId: true,
        purchaseReturn: { select: { returnNumber: true } },
        lines: { select: { itemId: true, qty: true, unitPrice: true } },
      },
    })
    if (!before) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
    assertTransition(before.status, 'CANCELLED', before.noteNumber)

    /*
     * Not on its own. Cancelling the note alone would leave the goods gone on
     * the challan and nothing charged back for them — the one state this
     * whole chain exists to make impossible. The challan is cancelled instead,
     * which puts the stock back and takes this note with it.
     */
    if (before.purchaseReturn) {
      throw new AppError(
        `${before.noteNumber} was raised from return challan ${before.purchaseReturn.returnNumber}. Cancel the challan instead — that puts the goods back in stock and cancels this note with it.`,
        409,
        'NOTE_FROM_RETURN'
      )
    }

    const wasPosted = before.status === 'POSTED'
    const moved = wasPosted ? await moveNoteStock(tx, before, 'REVERSE') : 0

    const note = await tx.purchaseNote.update({
      where: { id: before.id },
      data: {
        status: 'CANCELLED',
        closedById: req.user!.id,
        closedAt: new Date(),
        closedReason: reason ?? null,
      },
      include: noteInclude,
    })

    if (wasPosted && before.billId) await syncBillAdjustments(tx, before.billId)

    return { note, moved, wasPosted }
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseNote',
    entityId: result.note.id,
    after: result.note,
  })

  res.json({
    success: true,
    data: result.note,
    message:
      `${result.note.noteNumber} cancelled.` +
      (result.wasPosted ? ' The adjustment has been taken back off the bill.' : '') +
      (result.moved
        ? ` ${result.moved} line${result.moved === 1 ? '' : 's'} put back into stock.`
        : ''),
  })
})

/**
 * Deletes a draft, and only a draft.
 *
 * Anything that has been submitted has been seen by somebody else and is
 * cancelled instead, so the trail keeps saying it existed. The number it burnt
 * is gone either way — document numbers are never reissued.
 */
router.delete('/:id', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const note = await prisma.$transaction(async (tx) => {
    const before = await tx.purchaseNote.findUnique({
      where: { id: req.params.id },
      include: noteInclude,
    })
    if (!before) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
    if (before.purchaseReturn) {
      throw new AppError(
        `${before.noteNumber} was raised from return challan ${before.purchaseReturn.returnNumber}. Cancel the challan instead — the goods it sent back need a note against them for as long as it stands.`,
        409,
        'NOTE_FROM_RETURN'
      )
    }
    if (before.status !== 'DRAFT') {
      throw new AppError(
        `${before.noteNumber} has already been ${before.status.toLowerCase()}. Cancel it instead — the record has to stay.`,
        409,
        'NOT_A_DRAFT'
      )
    }
    if (before.attachments.length) {
      throw new AppError(
        `${before.noteNumber} has ${before.attachments.length} file(s) on it. Remove them first.`,
        409,
        'HAS_FILES'
      )
    }
    await tx.purchaseNote.delete({ where: { id: before.id } })
    return before
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'DELETE',
    entityType: 'PurchaseNote',
    entityId: note.id,
    before: note,
  })

  res.json({ success: true, message: `${note.noteNumber} deleted.` })
})

// ── Attachments ─────────────────────────────────────────────────────────────
//
// The same three-step pattern as an order's or a receipt's: ask for a link,
// send the file straight to storage, then tell us it landed. What goes on a
// note is the evidence behind the claim — the rejection report, the photo of
// the damaged bale, the supplier's own credit note.

const attachmentInclude = { uploadedBy: { select: { id: true, name: true } } }

router.get('/:id/attachments', requirePermission(MODULE, 'view'), async (req, res) => {
  const rows = await prisma.purchaseNoteAttachment.findMany({
    where: { noteId: req.params.id },
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
        .max(MAX_FILE_BYTES, `Files have to be ${MAX_FILE_BYTES / 1024 / 1024}MB or smaller`),
    })
    .parse(req.body)

  const note = await prisma.purchaseNote.findUnique({
    where: { id: req.params.id },
    select: { id: true, noteNumber: true },
  })
  if (!note) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')

  const already = await prisma.purchaseNoteAttachment.count({ where: { noteId: note.id } })
  if (already >= MAX_FILES_PER_DOCUMENT) {
    throw new AppError(
      `${note.noteNumber} already has ${MAX_FILES_PER_DOCUMENT} files. Remove one before adding another.`,
      409,
      'TOO_MANY_FILES'
    )
  }

  const path = storagePathFor('purchase-notes', note.id, fileName)
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

    const note = await prisma.purchaseNote.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    })
    if (!note) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')

    if (!storagePath.startsWith(`purchase-notes/${note.id}/`)) {
      throw new AppError('That file does not belong to this note', 400, 'WRONG_DOCUMENT')
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

    const attachment = await prisma.purchaseNoteAttachment.create({
      data: {
        noteId: note.id,
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
      entityType: 'PurchaseNoteAttachment',
      entityId: attachment.id,
      after: attachment,
    })

    res.status(201).json({ success: true, data: attachment })
  }
)

router.get('/attachments/:id/link', requirePermission(MODULE, 'view'), async (req, res) => {
  const file = await prisma.purchaseNoteAttachment.findUnique({ where: { id: req.params.id } })
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
    const file = await prisma.purchaseNoteAttachment.findUnique({
      where: { id: req.params.id },
      include: attachmentInclude,
    })
    if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')

    await prisma.purchaseNoteAttachment.delete({ where: { id: file.id } })
    await removeObject(file.storagePath).catch(() => {})

    await writeAuditLog(req, {
      module: MODULE,
      action: 'DELETE',
      entityType: 'PurchaseNoteAttachment',
      entityId: file.id,
      before: file,
    })

    res.json({ success: true, message: `${file.fileName} removed.` })
  }
)

export default router
