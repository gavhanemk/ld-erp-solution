import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { amountInWords, getPrintHeader } from '../lib/printData'
import { nextDocumentNumber } from '../lib/docNumber'
import { balanceOf, recordMovement } from '../services/stock.service'
import { qcRejectedByGrnLine, qcSummaryOf } from '../services/grnQc.service'
import {
  adjustableOn,
  DOC_RULES,
  effectFor,
  priceNote,
  REASON_RULES,
  taxContextFor,
  type NoteLineInput,
} from '../services/purchaseNote.service'
import {
  cancelReturnSchema,
  createReturnSchema,
  RETURN_REASONS,
  returnListQuerySchema,
} from '../schemas/purchase-return.schemas'

/**
 * Purchase return challans — goods going back to a supplier.
 *
 * The physical half of a return, separated from the financial half on
 * purpose. The godown loads the vehicle and the gate lets it out against a
 * challan; accounts decides afterwards what the return is worth and posts the
 * debit note. Before this, a debit note did both, so goods could leave with no
 * gate pass at all, or a gate pass could only exist once accounts had got
 * round to writing the note.
 *
 * The chain is Purchase Bill → Return Challan → Debit Note, and it is kept
 * strictly:
 *
 *   - A challan is always against a bill, line by line.
 *   - Saving one takes the goods out of stock at once — they are on the
 *     vehicle — and writes a DRAFT debit note linked back to it, priced at the
 *     bill's own rates, for accounts to review and post.
 *   - That note never moves stock (the challan already did), cannot be
 *     cancelled or deleted on its own, and keeps the challan's quantities.
 *   - The challan can be cancelled while its note is still a draft, which puts
 *     the goods back and cancels the note. Once the note is posted the
 *     supplier's account has been charged and the challan stands; goods that
 *     come back after that arrive on a fresh receipt.
 */

const MODULE = 'purchase'
const router = Router()

/** The series a challan draws from. One running sequence, PRC-0001 upward. */
const SERIES = 'PRC'

const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000

const returnInclude = {
  supplier: { select: { id: true, code: true, name: true, gstin: true, stateCode: true } },
  bill: {
    select: {
      id: true,
      billNumber: true,
      supplierInvoiceNo: true,
      supplierInvoiceDate: true,
      billDate: true,
      totalAmount: true,
      status: true,
    },
  },
  createdBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    select: {
      id: true,
      qty: true,
      unitPrice: true,
      gstRate: true,
      remarks: true,
      reason: true,
      billLineId: true,
      billLine: {
        select: {
          id: true,
          qty: true,
          hsnCode: true,
          description: true,
          // The receipt each line came in on, with the supplier's own delivery
          // challan and the order, so the printed challan can quote them back.
          grnLine: {
            select: {
              grn: {
                select: {
                  id: true,
                  grnNumber: true,
                  challanNo: true,
                  challanDate: true,
                  po: { select: { poNumber: true } },
                },
              },
            },
          },
        },
      },
      item: {
        select: { id: true, code: true, name: true, uom: { select: { symbol: true } } },
      },
      warehouse: { select: { id: true, code: true, name: true } },
    },
  },
  debitNotes: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      id: true,
      noteNumber: true,
      status: true,
      totalAmount: true,
      postedAt: true,
    },
  },
} satisfies Prisma.PurchaseReturnInclude

type ReturnRow = Prisma.PurchaseReturnGetPayload<{ include: typeof returnInclude }>

/**
 * What a challan is worth, worked out here so every screen reads the same
 * figure.
 *
 * The declared value of the goods, at the bill's rate, with GST shown as a
 * separate figure. It is what the gate pass carries and what an e-way bill is
 * raised on; the debit note may end up at a different amount if accounts
 * agrees a different rate with the supplier, and the note's own total is
 * reported beside it rather than in place of it.
 */
function shape(r: ReturnRow) {
  let taxable = 0
  let gst = 0
  for (const l of r.lines) {
    const v = Number(l.qty) * Number(l.unitPrice)
    taxable += v
    gst += (v * Number(l.gstRate)) / 100
  }
  return {
    ...r,
    // Each row's own reason in words, the challan's where the row has none.
    lines: r.lines.map((l) => ({
      ...l,
      reasonLabel: REASON_RULES[l.reason ?? r.reason].label,
    })),
    taxableValue: round2(taxable),
    gstValue: round2(gst),
    totalValue: round2(taxable + gst),
    reasonLabel: REASON_RULES[r.reason].label,
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const q = returnListQuerySchema.parse(req.query)

  const where: Prisma.PurchaseReturnWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.supplierId ? { supplierId: q.supplierId } : {}),
    ...(q.billId ? { billId: q.billId } : {}),
    ...(q.from || q.to
      ? {
          returnDate: {
            ...(q.from ? { gte: new Date(q.from + 'T00:00:00') } : {}),
            // The end of the day asked for, not its first instant — a return
            // at four in the afternoon on the 19th belongs to the 19th.
            ...(q.to ? { lte: new Date(q.to + 'T23:59:59.999') } : {}),
          },
        }
      : {}),
    ...(q.q
      ? {
          OR: [
            { returnNumber: { contains: q.q, mode: 'insensitive' } },
            { vehicleNo: { contains: q.q, mode: 'insensitive' } },
            { bill: { billNumber: { contains: q.q, mode: 'insensitive' } } },
            { bill: { supplierInvoiceNo: { contains: q.q, mode: 'insensitive' } } },
            { supplier: { name: { contains: q.q, mode: 'insensitive' } } },
            { debitNotes: { some: { noteNumber: { contains: q.q, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  }

  const [rows, total] = await Promise.all([
    prisma.purchaseReturn.findMany({
      where,
      include: returnInclude,
      orderBy: [{ returnDate: 'desc' }, { createdAt: 'desc' }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.purchaseReturn.count({ where }),
  ])

  res.json({
    success: true,
    data: rows.map(shape),
    pagination: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) || 1 },
  })
})

/**
 * What can still go back against a bill, line by line.
 *
 * The same ceiling the debit note uses — `adjustableOn` — because it is the
 * same question: how much of this line has not already been claimed back.
 * Every live note counts, including the draft notes earlier challans wrote,
 * so two challans cannot send the same hundred metres back twice.
 *
 * Each line also carries the godown it was received into and how much of the
 * item that godown holds right now. The goods go back from where they are,
 * and a challan for more than the rack holds is refused at save — saying so
 * on the form first is cheaper than a round trip that loses what was typed.
 */
router.get('/returnable/:billId', requirePermission(MODULE, 'view'), async (req, res) => {
  const bill = await prisma.purchaseInvoice.findUnique({
    where: { id: req.params.billId },
    select: {
      id: true,
      billNumber: true,
      supplierInvoiceNo: true,
      supplierInvoiceDate: true,
      billDate: true,
      status: true,
      totalAmount: true,
      supplier: { select: { id: true, code: true, name: true, gstin: true } },
      po: { select: { poNumber: true, poDate: true } },
    },
  })
  if (!bill) throw new AppError('That purchase bill no longer exists', 404, 'NOT_FOUND')

  /*
   * The paperwork behind the bill, for the challan to quote: which receipts
   * the billed goods came in on (with the supplier's own delivery challan and
   * the gate entry), the order they were bought on, and any quality check.
   * The godown and the supplier both ask for these when goods come back.
   */
  const receipts = await prisma.gRN.findMany({
    where: { lines: { some: { billLines: { some: { billId: bill.id } } } } },
    orderBy: { grnDate: 'asc' },
    select: {
      id: true,
      grnNumber: true,
      grnDate: true,
      challanNo: true,
      challanDate: true,
      gateEntryNo: true,
      gateEntryDate: true,
      vehicleNo: true,
      po: { select: { poNumber: true, poDate: true } },
      qcRecords: {
        orderBy: { inspectionDate: 'desc' },
        select: { id: true, result: true, inspectionDate: true, checklistData: true },
      },
    },
  })
  const references = {
    orders: [
      ...new Map(
        [bill.po, ...receipts.map((g) => g.po)]
          .filter((p): p is { poNumber: string; poDate: Date } => Boolean(p))
          .map((p) => [p.poNumber, p])
      ).values(),
    ],
    receipts: receipts.map((g) => ({
      grnNumber: g.grnNumber,
      grnDate: g.grnDate,
      challanNo: g.challanNo,
      challanDate: g.challanDate,
      gateEntryNo: g.gateEntryNo,
      gateEntryDate: g.gateEntryDate,
      vehicleNo: g.vehicleNo,
      qc: qcSummaryOf(g.qcRecords),
    })),
  }

  const lines = await prisma.$transaction((tx) => adjustableOn(tx, bill.id))

  /*
   * What a quality check rejected on each line, and the godown it was moved
   * to. Those goods are the commonest thing sent back, and they are no longer
   * in the godown the receipt named — so the form starts those lines on the
   * reject godown, with its stock beside it.
   */
  const grnLineOf = new Map(
    (
      await prisma.purchaseInvoiceLine.findMany({
        where: { billId: bill.id },
        select: { id: true, grnLineId: true },
      })
    ).map((l) => [l.id, l.grnLineId])
  )
  const qcRejected = await prisma.$transaction((tx) =>
    qcRejectedByGrnLine(
      tx,
      [...grnLineOf.values()].filter((v): v is string => Boolean(v))
    )
  )
  const qcGodownIds = [...qcRejected.values()]
    .map((q) => q.warehouseId)
    .filter((v): v is string => Boolean(v))
  const qcGodowns = new Map(
    (
      await prisma.warehouse.findMany({
        where: { id: { in: qcGodownIds } },
        select: { id: true, name: true },
      })
    ).map((w) => [w.id, w.name])
  )

  const withStock = await prisma.$transaction(async (tx) =>
    Promise.all(
      lines.map(async (l) => {
        const grnLineId = grnLineOf.get(l.billLineId)
        const qc = grnLineId ? qcRejected.get(grnLineId) : undefined
        return {
          ...l,
          onHand: l.warehouseId
            ? (await balanceOf(tx, { itemId: l.itemId, warehouseId: l.warehouseId })).qty
            : null,
          qcRejectedQty: qc?.qty ?? 0,
          // Why QC rejected it, picked from the challan's own reasons, and the
          // checker's note — the form starts the row on both.
          qcReasonCode: qc?.reasonCode ?? null,
          qcReasonNote: qc?.note ?? null,
          qcWarehouseId: qc?.warehouseId ?? null,
          qcWarehouseName: qc?.warehouseId ? (qcGodowns.get(qc.warehouseId) ?? null) : null,
          qcOnHand: qc?.warehouseId
            ? (await balanceOf(tx, { itemId: l.itemId, warehouseId: qc.warehouseId })).qty
            : null,
        }
      })
    )
  )

  res.json({
    success: true,
    data: {
      bill,
      references,
      lines: withStock,
      reasons: RETURN_REASONS.map((r) => ({
        value: r,
        label: REASON_RULES[r].label,
        hint: REASON_RULES[r].hint,
      })),
    },
  })
})

router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const row = await prisma.purchaseReturn.findUnique({
    where: { id: req.params.id },
    include: returnInclude,
  })
  if (!row) throw new AppError('That return challan no longer exists', 404, 'NOT_FOUND')
  res.json({ success: true, data: shape(row) })
})

router.get('/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const row = await prisma.purchaseReturn.findUnique({
    where: { id: req.params.id },
    include: {
      ...returnInclude,
      supplier: {
        select: {
          id: true,
          code: true,
          name: true,
          gstin: true,
          stateCode: true,
          address: true,
          city: true,
          state: true,
          pincode: true,
          phone: true,
        },
      },
    },
  })
  if (!row) throw new AppError('That return challan no longer exists', 404, 'NOT_FOUND')

  const header = await getPrintHeader(SERIES)
  const shaped = shape(row)

  res.json({
    success: true,
    data: {
      ...header,
      challan: shaped,
      totalInWords: amountInWords(shaped.totalValue),
    },
  })
})

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Raises a challan: the goods leave, and the note that charges for them is
 * written in the same breath.
 *
 * One transaction for all three — the challan, the stock movements and the
 * draft note — so there is never a moment where goods have left the rack with
 * no challan behind them, or a challan exists with nothing yet claimed for it.
 */
router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createReturnSchema.parse(req.body)
  const returnDate = data.returnDate ?? new Date()

  const result = await prisma.$transaction(async (tx) => {
    const bill = await tx.purchaseInvoice.findUnique({
      where: { id: data.billId },
      select: {
        id: true,
        billNumber: true,
        status: true,
        supplierId: true,
        lines: {
          select: {
            id: true,
            itemId: true,
            qty: true,
            unitPrice: true,
            gstRate: true,
            hsnCode: true,
            description: true,
          },
        },
      },
    })
    if (!bill) throw new AppError('That purchase bill no longer exists', 404, 'NOT_FOUND')
    if (bill.status === 'CANCELLED') {
      throw new AppError(
        `${bill.billNumber} is cancelled. Nothing on it can be sent back against it.`,
        400,
        'BILL_CANCELLED'
      )
    }

    const billLine = new Map(bill.lines.map((l) => [l.id, l]))
    for (const l of data.lines) {
      if (!billLine.has(l.billLineId)) {
        throw new AppError(
          'One of these lines is not on that bill any more. Reopen the bill and pick the lines again.',
          409,
          'BILL_LINE_GONE'
        )
      }
    }

    /*
     * Both ceilings, against everything already claimed on the bill.
     *
     * Quantity, so the same rolls cannot go back twice. Value, because a line
     * that has already had a rate correction claimed against it has less left
     * to claim than its quantity suggests, and the note this challan writes
     * would otherwise be refused the moment accounts tried to post it.
     */
    const available = new Map((await adjustableOn(tx, bill.id)).map((a) => [a.billLineId, a]))
    const wanted = new Map<string, number>()
    for (const l of data.lines) {
      wanted.set(l.billLineId, (wanted.get(l.billLineId) ?? 0) + l.qty)
    }
    for (const [billLineId, qty] of wanted) {
      const a = available.get(billLineId)!
      const unit = a.uom ? ` ${a.uom}` : ''
      if (qty > a.remainingQty + 0.0005) {
        throw new AppError(
          `Only ${a.remainingQty}${unit} of ${a.itemName} can still go back against ${bill.billNumber}` +
            (a.adjustedQty > 0
              ? ` — ${a.billedQty}${unit} was billed and ${a.adjustedQty}${unit} is already on returns or notes.`
              : '.') +
            ` This challan sends ${round3(qty)}${unit}.`,
          400,
          'OVER_RETURNED'
        )
      }
      const value = round2(qty * a.billedRate)
      if (value > a.remainingValue + 0.005) {
        throw new AppError(
          `${a.itemName} has ₹${a.remainingValue.toLocaleString('en-IN')} left to claim on ${bill.billNumber}, ` +
            `and ${round3(qty)}${unit} at the bill's rate comes to ₹${value.toLocaleString('en-IN')}. ` +
            `An earlier note has already claimed part of this line's value.`,
          400,
          'OVER_RETURNED_VALUE'
        )
      }
    }

    /*
     * Each row's reason, and the challan's own.
     *
     * Every row says why it is going back (the schema refuses one that does
     * not, unless an older caller sent a reason for the whole challan). The
     * challan carries whichever reason sends back the most, so its one-word
     * summary — on the list, on the note — is the main reason. The rows keep
     * the rest.
     */
    const reasonOf = (l: (typeof data.lines)[number]) => (l.reason ?? data.reason)!
    const qtyByReason = new Map<(typeof data.lines)[number]['reason'] & string, number>()
    for (const l of data.lines) {
      qtyByReason.set(reasonOf(l), (qtyByReason.get(reasonOf(l)) ?? 0) + l.qty)
    }
    const mainReason = [...qtyByReason].sort((a, b) => b[1] - a[1])[0][0]
    const mixedReasons = qtyByReason.size > 1

    const returnNumber = await nextDocumentNumber(tx, SERIES, returnDate)

    const created = await tx.purchaseReturn.create({
      data: {
        returnNumber,
        returnDate,
        supplierId: bill.supplierId,
        billId: bill.id,
        reason: mainReason,
        reasonNote: data.reasonNote,
        vehicleNo: data.vehicleNo,
        transporterName: data.transporterName,
        lrNumber: data.lrNumber,
        ewayBillNo: data.ewayBillNo,
        driverName: data.driverName,
        remarks: data.remarks,
        createdById: req.user!.id,
        lines: {
          create: data.lines.map((l, i) => {
            const b = billLine.get(l.billLineId)!
            return {
              itemId: b.itemId,
              billLineId: b.id,
              warehouseId: l.warehouseId,
              qty: round3(l.qty),
              unitPrice: b.unitPrice,
              gstRate: b.gstRate,
              remarks: l.remarks,
              reason: reasonOf(l),
              sortOrder: i,
            }
          }),
        },
      },
    })

    /*
     * Off the rack, now. `recordMovement` refuses to take out more than the
     * godown holds and names the shortfall, which is the message the loading
     * bay needs: the book says there are forty rolls there, you are sending
     * sixty.
     */
    for (const l of data.lines) {
      const b = billLine.get(l.billLineId)!
      await recordMovement(tx, {
        itemId: b.itemId,
        warehouseId: l.warehouseId,
        direction: 'OUT',
        transactionType: 'RETURN',
        referenceType: 'PurchaseReturn',
        referenceId: created.id,
        qty: round3(l.qty),
        transactionDate: returnDate,
        notes: `Returned to supplier on ${returnNumber}`,
      })
    }

    /*
     * The money side, as a draft for accounts.
     *
     * Priced at the bill's own rates and split for tax the way the bill was,
     * so a return that goes through untouched reverses exactly what was
     * charged. Accounts can change the rate before posting — a supplier who
     * takes goods back at less than he billed them is common — but not what
     * went back or how much.
     */
    const isIntraState = await taxContextFor(tx, bill.supplierId, bill.id)
    const noteLines: NoteLineInput[] = data.lines.map((l) => {
      const b = billLine.get(l.billLineId)!
      return {
        itemId: b.itemId,
        billLineId: b.id,
        description: b.description,
        hsnCode: b.hsnCode,
        originalQty: Number(b.qty),
        originalRate: Number(b.unitPrice),
        qty: round3(l.qty),
        unitPrice: Number(b.unitPrice),
        gstRate: Number(b.gstRate),
        // A note has one reason of its own, so on a mixed challan each line
        // says its own — the supplier reads why every row is being charged.
        remarks: mixedReasons
          ? [REASON_RULES[reasonOf(l)].label, l.remarks].filter(Boolean).join(' — ')
          : l.remarks,
      }
    })
    const priced = priceNote({ lines: noteLines, isIntraState })
    const noteNumber = await nextDocumentNumber(tx, DOC_RULES.OUR_DEBIT_NOTE.series, returnDate)

    const note = await tx.purchaseNote.create({
      data: {
        noteNumber,
        reason: mainReason,
        reasonNote: data.reasonNote,
        issuedBy: 'OUR_COMPANY',
        docType: 'OUR_DEBIT_NOTE',
        effect: effectFor('OUR_DEBIT_NOTE', null),
        supplierId: bill.supplierId,
        billId: bill.id,
        returnId: created.id,
        noteDate: returnDate,
        vehicleNo: data.vehicleNo,
        lrNumber: data.lrNumber,
        // Deliberately no godown. The challan moved the goods; the note is
        // the money. `moveNoteStock` checks the link as well, so a godown
        // filled in later on the note form still moves nothing.
        warehouseId: null,
        isIntraState,
        taxableAmount: priced.taxableAmount,
        discountAmount: priced.discountAmount,
        cgst: priced.cgst,
        sgst: priced.sgst,
        igst: priced.igst,
        otherCharges: priced.otherCharges,
        roundOff: priced.roundOff,
        totalAmount: priced.totalAmount,
        notes: `Raised from return challan ${returnNumber}.`,
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
      select: { id: true, noteNumber: true },
    })

    const full = await tx.purchaseReturn.findUniqueOrThrow({
      where: { id: created.id },
      include: returnInclude,
    })
    return { challan: shape(full), note }
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'PurchaseReturn',
    entityId: result.challan.id,
    after: result.challan,
  })

  res.status(201).json({
    success: true,
    data: result.challan,
    message:
      `${result.challan.returnNumber} saved and the goods are out of stock. ` +
      `${result.note.noteNumber} has been written as a draft for accounts to post.`,
  })
})

/**
 * Cancels a challan: the goods go back on the rack, and its draft note goes.
 *
 * Only while that note is still a draft. Once it is posted the supplier's
 * account has been charged for the return, and taking the challan away would
 * leave a posted claim for goods the stock ledger says never left. Goods that
 * come back after that point arrive the way any goods arrive — on a receipt.
 *
 * The stock goes back in at the rate it went out at, read off the challan's
 * own ledger rows. Any other rate would leave value on the books that no
 * quantity accounts for.
 */
router.post('/:id/cancel', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = cancelReturnSchema.parse(req.body ?? {})

  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.purchaseReturn.findUnique({
      where: { id: req.params.id },
      include: returnInclude,
    })
    if (!before) throw new AppError('That return challan no longer exists', 404, 'NOT_FOUND')
    if (before.status === 'CANCELLED') {
      throw new AppError(`${before.returnNumber} is already cancelled.`, 409, 'ALREADY_CANCELLED')
    }

    const settled = before.debitNotes.filter(
      (n) => n.status !== 'DRAFT' && n.status !== 'CANCELLED'
    )
    if (settled.length) {
      throw new AppError(
        `${settled.map((n) => n.noteNumber).join(', ')} against this challan ${
          settled.length === 1 ? 'has' : 'have'
        } already been posted, so the supplier has been charged for the return. ` +
          `${before.returnNumber} stands; if the goods come back, receive them on a new goods receipt.`,
        409,
        'NOTE_POSTED'
      )
    }

    const out = await tx.stockLedger.findMany({
      where: { referenceType: 'PurchaseReturn', referenceId: before.id, outQty: { gt: 0 } },
      select: { itemId: true, warehouseId: true, outQty: true, unitRate: true },
    })
    for (const m of out) {
      await recordMovement(tx, {
        itemId: m.itemId,
        warehouseId: m.warehouseId,
        direction: 'IN',
        transactionType: 'RETURN',
        referenceType: 'PurchaseReturn',
        referenceId: before.id,
        qty: Number(m.outQty),
        unitRate: Number(m.unitRate ?? 0),
        notes: `${before.returnNumber} cancelled — goods back in stock`,
      })
    }

    const now = new Date()
    await tx.purchaseNote.updateMany({
      where: { returnId: before.id, status: 'DRAFT' },
      data: {
        status: 'CANCELLED',
        closedById: req.user!.id,
        closedAt: now,
        closedReason: `Return challan ${before.returnNumber} cancelled: ${reason}`,
      },
    })

    await tx.purchaseReturn.update({
      where: { id: before.id },
      data: {
        status: 'CANCELLED',
        cancelledById: req.user!.id,
        cancelledAt: now,
        cancelReason: reason,
      },
    })

    const after = await tx.purchaseReturn.findUniqueOrThrow({
      where: { id: before.id },
      include: returnInclude,
    })
    return { before: shape(before), after: shape(after), restocked: out.length }
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseReturn',
    entityId: result.after.id,
    before: result.before,
    after: result.after,
  })

  res.json({
    success: true,
    data: result.after,
    message:
      `${result.after.returnNumber} cancelled. ` +
      `${result.restocked} line${result.restocked === 1 ? '' : 's'} put back into stock` +
      (result.after.debitNotes.length ? ', and its draft debit note cancelled with it.' : '.'),
  })
})

export default router
