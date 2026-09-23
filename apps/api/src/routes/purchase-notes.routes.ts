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
  assertEditable,
  moveNoteStock,
  priceNote,
  REASON_RULES,
  syncBillAdjustments,
  TRANSITIONS,
  type NoteLineInput,
} from '../services/purchaseNote.service'
import {
  createNoteSchema,
  noteListQuerySchema,
  updateNoteSchema,
} from '../schemas/purchase-note.schemas'

/**
 * Debit and credit notes against a supplier.
 *
 * What the mill claims back, and what a supplier grants. One router for both:
 * they adjust the same bill against the same remaining balance and differ in
 * who signed the paper, so splitting them would have been two of every route
 * below, drifting apart from the first change onwards. `noteType` is a filter
 * on the list and a field on the form; everything else is shared.
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

/**
 * The state a supplier is in for tax, read once and frozen onto the note.
 *
 * Copied from the bill where there is one, because an adjustment has to carry
 * the same split as the document it corrects — a CGST bill credited with IGST
 * leaves a difference on the GST return that nobody can clear.
 */
async function taxContextFor(
  tx: Prisma.TransactionClient,
  supplierId: string,
  billId: string | null | undefined
): Promise<boolean> {
  if (billId) {
    const bill = await tx.purchaseInvoice.findUnique({
      where: { id: billId },
      select: { igst: true, cgst: true, sgst: true },
    })
    if (bill && (Number(bill.igst) > 0 || Number(bill.cgst) > 0 || Number(bill.sgst) > 0)) {
      return Number(bill.igst) <= 0
    }
  }

  const [company, supplier] = await Promise.all([
    tx.company.findFirst({ select: { stateCode: true, gstin: true } }),
    tx.supplier.findUnique({ where: { id: supplierId }, select: { stateCode: true, gstin: true } }),
  ])
  const ours = company?.stateCode || company?.gstin?.slice(0, 2)
  const theirs = supplier?.stateCode || supplier?.gstin?.slice(0, 2)
  // An unregistered supplier carries no split to make, and a note against them
  // carries no tax either. Treated as intra-state so nothing lands in IGST.
  return !theirs || !ours || theirs === ours
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * The catalogue the form's "What happened?" list is built from.
 *
 * Served rather than duplicated in the web app, so the wording a buyer reads
 * and the rule the server enforces cannot drift apart.
 */
router.get('/reasons', requirePermission(MODULE, 'view'), (_req, res) => {
  res.json({
    success: true,
    data: Object.entries(REASON_RULES).map(([value, r]) => ({
      value,
      label: r.label,
      hint: r.hint,
      defaultType: r.type,
      effect: r.effect,
      movesGoods: r.movesGoods,
      consumesQty: r.consumesQty,
    })),
  })
})

router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const q = noteListQuerySchema.parse(req.query)

  const where: Prisma.PurchaseNoteWhereInput = {
    ...(q.noteType ? { noteType: q.noteType } : {}),
    ...(q.status ? { status: q.status } : {}),
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

  const [rows, total, summary] = await Promise.all([
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
  ])

  res.json({
    success: true,
    data: rows,
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

  const header = await getPrintHeader(note.noteType === 'DEBIT' ? 'DN' : 'SCN')

  res.json({
    success: true,
    data: {
      ...header,
      note,
      reasonLabel: REASON_RULES[note.reason].label,
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
 * types a rate the bill never carried.
 */
async function assertWithinBill(
  tx: Prisma.TransactionClient,
  opts: {
    billId: string
    reason: keyof typeof REASON_RULES
    lines: NoteLineInput[]
    pricedLines: Array<{ taxableValue: number }>
    excludeNoteId?: string
  }
): Promise<void> {
  const available = await adjustableOn(tx, opts.billId, opts.excludeNoteId)
  const byId = new Map(available.map((a) => [a.billLineId, a]))
  const consumesQty = REASON_RULES[opts.reason].consumesQty

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

    if (consumesQty && qty > line.remainingQty + 0.0005) {
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
    if (value > line.remainingValue + 0.005) {
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

router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createNoteSchema.parse(req.body)

  const note = await prisma.$transaction(async (tx) => {
    // The supplier comes from the bill when there is one. A note whose
    // supplier disagrees with the bill it adjusts is a note that reduces the
    // wrong party's payable, so it is derived and not taken on trust.
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
        lines: data.lines,
        pricedLines: priced.lines,
      })
    }

    const noteNumber = await nextDocumentNumber(
      tx,
      data.noteType === 'DEBIT' ? 'DN' : 'SCN',
      data.noteDate
    )

    return tx.purchaseNote.create({
      data: {
        noteNumber,
        noteType: data.noteType,
        reason: data.reason,
        reasonNote: data.reasonNote ?? null,
        effect: data.effect,
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
    message: `${note.noteNumber} saved as a draft. Submit it when you are ready.`,
  })
})

router.patch('/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = updateNoteSchema.parse(req.body)

  const note = await prisma.$transaction(async (tx) => {
    const before = await tx.purchaseNote.findUnique({
      where: { id: req.params.id },
      select: { id: true, noteNumber: true, status: true, noteType: true, supplierId: true },
    })
    if (!before) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
    assertEditable(before.status, before.noteNumber)

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
        noteType: data.noteType,
        reason: data.reason,
        reasonNote: data.reasonNote ?? null,
        effect: data.effect,
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

router.post('/:id/submit', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const note = await prisma.$transaction(async (tx) => {
    const before = await tx.purchaseNote.findUnique({
      where: { id: req.params.id },
      select: { id: true, noteNumber: true, status: true, totalAmount: true },
    })
    if (!before) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
    assertTransition(before.status, 'SUBMITTED', before.noteNumber)
    if (Number(before.totalAmount) <= 0) {
      throw new AppError(
        `${before.noteNumber} claims nothing. There is nothing to submit.`,
        400,
        'NOTHING_CLAIMED'
      )
    }

    return tx.purchaseNote.update({
      where: { id: before.id },
      data: { status: 'SUBMITTED', submittedById: req.user!.id, submittedAt: new Date() },
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
  res.json({ success: true, data: note, message: `${note.noteNumber} sent for approval.` })
})

/**
 * Approval, by somebody other than the person who raised it.
 *
 * docs/04-business-rules.md forbids the two being the same hand, and this is
 * the document where that matters most: it is a claim on a trading partner,
 * and a buyer who can raise and approve their own can write off a purchase
 * without anybody else in the building knowing.
 */
router.post('/:id/approve', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const note = await prisma.$transaction(async (tx) => {
    const before = await tx.purchaseNote.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        noteNumber: true,
        status: true,
        createdById: true,
        createdBy: { select: { name: true } },
      },
    })
    if (!before) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
    assertTransition(before.status, 'APPROVED', before.noteNumber)
    if (before.createdById === req.user!.id) {
      throw new AppError(
        `${before.noteNumber} was raised by you. Somebody else has to approve it.`,
        403,
        'SELF_APPROVAL'
      )
    }

    return tx.purchaseNote.update({
      where: { id: before.id },
      data: { status: 'APPROVED', approvedById: req.user!.id, approvedAt: new Date() },
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
  res.json({ success: true, data: note, message: `${note.noteNumber} approved.` })
})

router.post('/:id/reject', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const { reason } = reasonBody.parse(req.body ?? {})

  const note = await prisma.$transaction(async (tx) => {
    const before = await tx.purchaseNote.findUnique({
      where: { id: req.params.id },
      select: { id: true, noteNumber: true, status: true },
    })
    if (!before) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
    assertTransition(before.status, 'REJECTED', before.noteNumber)

    return tx.purchaseNote.update({
      where: { id: before.id },
      data: {
        status: 'REJECTED',
        closedById: req.user!.id,
        closedAt: new Date(),
        closedReason: reason ?? null,
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
  res.json({
    success: true,
    data: note,
    message: `${note.noteNumber} sent back. The buyer can reopen it as a draft.`,
  })
})

/** A rejected note goes back to the buyer's hands rather than to the bin. */
router.post('/:id/reopen', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const note = await prisma.$transaction(async (tx) => {
    const before = await tx.purchaseNote.findUnique({
      where: { id: req.params.id },
      select: { id: true, noteNumber: true, status: true },
    })
    if (!before) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
    assertTransition(before.status, 'DRAFT', before.noteNumber)

    return tx.purchaseNote.update({
      where: { id: before.id },
      data: {
        status: 'DRAFT',
        submittedById: null,
        submittedAt: null,
        approvedById: null,
        approvedAt: null,
        closedById: null,
        closedAt: null,
        closedReason: null,
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
  res.json({ success: true, data: note, message: `${note.noteNumber} is a draft again.` })
})

/**
 * Posts it — the only step that moves anything.
 *
 * Two legs, inside one transaction. The payable is recomputed from the bill's
 * posted notes, and the goods come off the rack where the reason says material
 * actually moved. Either both happen or neither does: a note that reduced a
 * payable without taking the cloth out of stock is how a godown ends up
 * holding fabric the books have already sent back.
 */
router.post('/:id/post', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.purchaseNote.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        noteNumber: true,
        status: true,
        reason: true,
        warehouseId: true,
        noteDate: true,
        billId: true,
        lines: { select: { itemId: true, qty: true, unitPrice: true } },
      },
    })
    if (!before) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
    assertTransition(before.status, 'POSTED', before.noteNumber)

    const moved = await moveNoteStock(tx, before, 'OUT')

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

    return { note, moved }
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
        ? ` ${result.moved} line${result.moved === 1 ? '' : 's'} taken out of stock.`
        : ''),
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
        warehouseId: true,
        noteDate: true,
        billId: true,
        lines: { select: { itemId: true, qty: true, unitPrice: true } },
      },
    })
    if (!before) throw new AppError('That note no longer exists', 404, 'NOT_FOUND')
    assertTransition(before.status, 'CANCELLED', before.noteNumber)

    const wasPosted = before.status === 'POSTED'
    const moved = wasPosted ? await moveNoteStock(tx, before, 'IN') : 0

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
