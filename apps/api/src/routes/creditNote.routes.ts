import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AuthRequest, requirePermission, userCan } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { applyRoundOff, nextDocumentNumber, resolvePlaceOfSupply } from '../lib/docNumber'
import { amountInWords, getPrintHeader } from '../lib/printData'
import { stateName } from '../lib/gstStates'
import { recordMovement } from '../services/stock.service'
import { syncInvoiceFromReceipts } from '../services/salesReceipt.service'
import { fgRates } from './finishedGoods.routes'

/**
 * Credit notes: an invoice reduced after the fact, always against that invoice.
 *
 * Two kinds. A RETURN brings goods back: pieces by size into a store, at the
 * value they go into stock at (the approved BOM cost, else the standard
 * rate), and the invoice credited at what it charged for them — its own
 * taxable value per piece and GST rate. An ADJUSTMENT moves no goods: a rate
 * difference or a discount given after the invoice, credited line by line.
 * Nothing can be returned or credited twice.
 *
 * A credit note reduces what the invoice still owes, as far as that goes; any
 * more — the invoice was already paid — stays with the customer as credit,
 * counted like an advance. Final when issued. Cancelled with a reason, which
 * takes returned goods back out of the store and restores the invoice.
 *
 * Mounted at /api/sales/credit-notes, ahead of /api/sales. Sales returns are
 * handled here, not through LD Silk Mills' Head Office (9 Oct 2026).
 */

const router = Router()
const MODULE = 'sales'
const round2 = (n: number) => Math.round(n * 100) / 100
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function mustSee(req: AuthRequest) {
  if (!userCan(req.user, MODULE, 'view') && !userCan(req.user, 'accounts', 'view')) {
    throw new AppError('You do not have permission to view credit notes', 403, 'FORBIDDEN')
  }
}

export const creditNoteSchema = z
  .object({
    invoiceId: z.string().min(1, 'Pick the invoice'),
    type: z.enum(['RETURN', 'ADJUSTMENT']),
    noteDate: z.coerce.date().optional(),
    warehouseId: z.string().optional().nullable(),
    reason: z.string().trim().min(3, 'Say why, in a few words').max(300),
    notes: z.string().max(1000).optional().nullable(),
    lines: z
      .array(
        z.object({
          invoiceLineId: z.string().min(1),
          /** Pieces back, by size, for a garment invoiced in sizes. */
          sizes: z.array(z.object({ sizeId: z.string().min(1), qty: z.number().min(0) })).optional(),
          /** Pieces back, for one with no sizes. */
          qty: z.number().min(0).optional(),
          /** For an adjustment: the value credited before GST. */
          amount: z.number().min(0).optional(),
        }),
      )
      .min(1, 'Put at least one line on it'),
  })
  .superRefine((d, ctx) => {
    if (d.type === 'RETURN' && !d.warehouseId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['warehouseId'], message: 'Say which store the goods come back into' })
    if (d.noteDate && d.noteDate > new Date()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['noteDate'], message: 'A credit note cannot be dated in the future' })
    const ids = d.lines.map((l) => l.invoiceLineId)
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'The same invoice line appears twice' })
  })

type CreditNoteInput = z.infer<typeof creditNoteSchema>

const invoiceForCredit = {
  customer: { select: { id: true, name: true } },
  dc: { select: { dcNumber: true, warehouseId: true, lines: { select: { soLineId: true, sizes: { select: { sizeId: true, qty: true, size: { select: { code: true, sequence: true } } } } } } } },
  lines: {
    orderBy: { sortOrder: 'asc' },
    include: {
      item: { select: { id: true, code: true, name: true, color: true, styleId: true, standardRate: true } },
      creditLines: {
        where: { note: { status: 'ISSUED' } },
        select: { qty: true, taxableValue: true, note: { select: { type: true } }, sizes: { select: { sizeId: true, qty: true } } },
      },
    },
  },
} satisfies Prisma.SalesInvoiceInclude

type InvoiceForCredit = Prisma.SalesInvoiceGetPayload<{ include: typeof invoiceForCredit }>

/** Per invoice line: what was invoiced, by size from the challan, and what is already credited. */
function lineState(inv: InvoiceForCredit) {
  return inv.lines.map((l) => {
    const qty = Number(l.qty)
    const sentSizes = inv.dc?.lines.find((d) => d.soLineId === l.soLineId)?.sizes ?? []
    const returnedBySize = new Map<string, number>()
    let returned = 0
    let credited = 0
    for (const c of l.creditLines) {
      credited += Number(c.taxableValue)
      if (c.note.type === 'RETURN') {
        returned += Number(c.qty)
        for (const s of c.sizes) returnedBySize.set(s.sizeId, (returnedBySize.get(s.sizeId) ?? 0) + Number(s.qty))
      }
    }
    return {
      line: l,
      qty,
      /** What the invoice charged for one piece, before GST: its discounts already in. */
      perPiece: qty > 0 ? Number(l.taxableValue) / qty : 0,
      returned: round2(returned),
      credited: round2(credited),
      sizes: [...sentSizes]
        .sort((a, b) => a.size.sequence - b.size.sequence)
        .map((s) => ({ sizeId: s.sizeId, code: s.size.code, invoiced: Number(s.qty), returned: returnedBySize.get(s.sizeId) ?? 0 })),
    }
  })
}

async function loadInvoice(db: Prisma.TransactionClient | typeof prisma, invoiceId: string) {
  const inv = await db.salesInvoice.findUnique({ where: { id: invoiceId }, include: invoiceForCredit })
  if (!inv) throw new AppError('Invoice not found', 404, 'NOT_FOUND')
  if (inv.status === 'CANCELLED') throw new AppError(`${inv.invoiceNumber} is cancelled, so there is nothing to credit`, 409, 'INVOICE_CANCELLED')
  return inv
}

/** GET /api/sales/credit-notes/prepare?invoiceId= — the invoice, line by line, with what can still be returned or credited. */
router.get('/prepare', requirePermission(MODULE, 'create'), async (req, res) => {
  const invoiceId = text(req.query.invoiceId)
  if (!invoiceId) throw new AppError('Pick the invoice', 400, 'NO_INVOICE')
  const inv = await loadInvoice(prisma, invoiceId)
  const stores = await prisma.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  res.json({
    success: true,
    data: {
      invoice: {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate,
        totalAmount: Number(inv.totalAmount),
        balanceAmount: Number(inv.balanceAmount),
        customer: inv.customer,
        dcNumber: inv.dc?.dcNumber ?? null,
        isIntraState: Number(inv.igst) > 0 ? false : Number(inv.cgst) > 0 ? true : null,
      },
      stores,
      defaultStoreId: inv.dc?.warehouseId ?? stores.find((s) => /finish/i.test(s.name))?.id ?? stores[0]?.id ?? null,
      lines: lineState(inv).map((s) => ({
        invoiceLineId: s.line.id,
        item: { code: s.line.item.code, name: s.line.item.name, color: s.line.item.color },
        hsnCode: s.line.hsnCode,
        qty: s.qty,
        perPiece: round2(s.perPiece),
        taxableValue: Number(s.line.taxableValue),
        gstRate: Number(s.line.gstRate),
        returned: s.returned,
        credited: s.credited,
        sizes: s.sizes,
      })),
    },
  })
})

/** Issues a credit note inside the caller's transaction. Exported for the checks that roll it back. */
export async function createCreditNote(tx: Prisma.TransactionClient, data: CreditNoteInput, userId: string) {
  const inv = await loadInvoice(tx, data.invoiceId)
  const { isIntraState } = await resolvePlaceOfSupply(tx, inv.customerId, inv.placeOfSupplyCode)
  const state = new Map(lineState(inv).map((s) => [s.line.id, s]))
  if (data.type === 'RETURN') {
    const store = await tx.warehouse.findUnique({ where: { id: data.warehouseId! }, select: { name: true, isActive: true } })
    if (!store) throw new AppError('That store does not exist', 400, 'BAD_WAREHOUSE')
    if (!store.isActive) throw new AppError(`${store.name} is switched off`, 400, 'INACTIVE')
  }

  const lines = data.lines
    .map((input) => {
      const s = state.get(input.invoiceLineId)
      if (!s) throw new AppError(`One of the lines is not on ${inv.invoiceNumber}`, 400, 'BAD_LINE')
      const code = s.line.item.code
      let qty = 0
      let sizes: Array<{ sizeId: string; qty: number }> = []
      let taxable = 0
      if (data.type === 'RETURN') {
        if (s.sizes.length) {
          sizes = (input.sizes ?? []).filter((z) => z.qty > 0)
          for (const z of sizes) {
            const sz = s.sizes.find((x) => x.sizeId === z.sizeId)
            if (!sz) throw new AppError(`${code}: that size was not on the invoice`, 400, 'BAD_SIZE')
            if (z.qty > sz.invoiced - sz.returned + 1e-9) {
              throw new AppError(`${code} size ${sz.code}: only ${sz.invoiced - sz.returned} can come back`, 400, 'MORE_THAN_INVOICED')
            }
          }
          qty = sizes.reduce((t, z) => t + z.qty, 0)
        } else {
          qty = input.qty ?? 0
        }
        if (qty <= 0) return null
        if (qty > s.qty - s.returned + 1e-9) throw new AppError(`${code}: only ${round2(s.qty - s.returned)} can come back`, 400, 'MORE_THAN_INVOICED')
        taxable = round2(qty * s.perPiece)
      } else {
        taxable = round2(input.amount ?? 0)
        if (taxable <= 0) return null
        qty = 0
      }
      const room = round2(Number(s.line.taxableValue) - s.credited)
      if (taxable > room + 0.01) throw new AppError(`${code}: only ₹${room.toFixed(2)} of it is left to credit`, 400, 'MORE_THAN_INVOICED')
      const tax = (taxable * Number(s.line.gstRate)) / 100
      const cgst = isIntraState ? round2(tax / 2) : 0
      const sgst = isIntraState ? round2(tax / 2) : 0
      const igst = isIntraState ? 0 : round2(tax)
      return { s, qty, sizes, taxable, cgst, sgst, igst }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
  if (!lines.length) throw new AppError(data.type === 'RETURN' ? 'Put the pieces coming back against at least one line' : 'Put the amount to credit against at least one line', 400, 'NOTHING_TO_CREDIT')

  const taxableAmount = round2(lines.reduce((t, l) => t + l.taxable, 0))
  const cgst = round2(lines.reduce((t, l) => t + l.cgst, 0))
  const sgst = round2(lines.reduce((t, l) => t + l.sgst, 0))
  const igst = round2(lines.reduce((t, l) => t + l.igst, 0))
  const { rounded, roundOff } = applyRoundOff(taxableAmount + cgst + sgst + igst)

  // As far as the invoice still owes; beyond that, credit the customer holds.
  const owed = round2(Math.max(0, Number(inv.totalAmount) - Number(inv.paidAmount) - Number(inv.tdsAmount) - Number(inv.creditedAmount)))
  const applied = round2(Math.min(rounded, owed))
  const noteDate = data.noteDate ?? new Date()
  const noteNumber = await nextDocumentNumber(tx, 'CN', noteDate)

  const note = await tx.creditNote.create({
    data: {
      noteNumber,
      customerId: inv.customerId,
      invoiceId: inv.id,
      noteDate,
      type: data.type,
      warehouseId: data.type === 'RETURN' ? data.warehouseId! : null,
      placeOfSupplyCode: inv.placeOfSupplyCode,
      reason: data.reason,
      notes: data.notes ?? null,
      subtotal: taxableAmount,
      taxableAmount,
      cgst,
      sgst,
      igst,
      roundOff,
      totalAmount: rounded,
      onAccount: round2(rounded - applied),
      status: 'ISSUED',
      createdById: userId,
      lines: {
        create: lines.map((l, i) => ({
          itemId: l.s.line.itemId,
          invoiceLineId: l.s.line.id,
          description: data.type === 'RETURN' ? `Returned: ${l.s.line.item.name}` : `Credit on ${l.s.line.item.name}`,
          hsnCode: l.s.line.hsnCode,
          qty: l.qty,
          unitPrice: l.qty > 0 ? round2(l.taxable / l.qty) : 0,
          taxableValue: l.taxable,
          gstRate: Number(l.s.line.gstRate),
          cgst: l.cgst,
          sgst: l.sgst,
          igst: l.igst,
          amount: round2(l.taxable + l.cgst + l.sgst + l.igst),
          sortOrder: i,
          sizes: l.sizes.length ? { create: l.sizes.map((z) => ({ sizeId: z.sizeId, qty: z.qty })) } : undefined,
        })),
      },
    },
  })

  // The goods back on the shelf, size by size, at the value they go into stock at.
  if (data.type === 'RETURN') {
    const items = [...new Map(lines.map((l) => [l.s.line.item.id, l.s.line.item])).values()]
    const rates = await fgRates(tx, items)
    for (const l of lines) {
      const rate = rates.get(l.s.line.itemId)?.rate ?? (l.qty > 0 ? l.taxable / l.qty : 0)
      const parts = l.sizes.length ? l.sizes.map((z) => ({ sizeId: z.sizeId as string | null, qty: z.qty })) : [{ sizeId: null, qty: l.qty }]
      for (const p of parts) {
        await recordMovement(tx, {
          itemId: l.s.line.itemId,
          warehouseId: data.warehouseId!,
          sizeId: p.sizeId,
          transactionType: 'RETURN',
          direction: 'IN',
          qty: p.qty,
          unitRate: round2(rate),
          referenceType: 'CREDIT_NOTE',
          referenceId: note.id,
          transactionDate: noteDate,
          notes: `Sales return, ${noteNumber} against ${inv.invoiceNumber}`,
        })
      }
    }
  }

  await tx.salesInvoice.update({ where: { id: inv.id }, data: { creditedAmount: { increment: applied } } })
  await syncInvoiceFromReceipts(tx, inv.id)
  return tx.creditNote.findUniqueOrThrow({ where: { id: note.id }, include: noteInclude })
}

const noteInclude = {
  customer: { select: { id: true, name: true, gstin: true, billingAddress: true, billingCity: true, billingState: true, billingStateCode: true, billingPincode: true } },
  invoice: { select: { id: true, invoiceNumber: true, invoiceDate: true, totalAmount: true, balanceAmount: true } },
  warehouse: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  lines: {
    orderBy: { sortOrder: 'asc' },
    include: {
      item: { select: { id: true, code: true, name: true, color: true } },
      sizes: { include: { size: { select: { code: true, sequence: true } } }, orderBy: { size: { sequence: 'asc' } } },
    },
  },
} satisfies Prisma.CreditNoteInclude

router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = creditNoteSchema.parse(req.body)
  const note = await prisma.$transaction((tx) => createCreditNote(tx, data, req.user!.id), { timeout: 60_000 })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'CreditNote', entityId: note.id, after: note })
  const held = Number(note.onAccount)
  res.status(201).json({
    success: true,
    message: `${note.noteNumber} issued against ${note.invoice?.invoiceNumber}: ₹${Number(note.totalAmount).toLocaleString('en-IN')}${
      note.type === 'RETURN' ? `, goods back in ${note.warehouse?.name}` : ''
    }.${held > 0 ? ` ₹${held.toLocaleString('en-IN')} is more than the invoice owed and stays as credit with ${note.customer.name}.` : ''}`,
    data: note,
  })
})

/** Cancels a credit note inside the caller's transaction. */
export async function cancelCreditNote(tx: Prisma.TransactionClient, id: string, userId: string, reason: string) {
  const before = await tx.creditNote.findUnique({ where: { id }, include: noteInclude })
  if (!before) throw new AppError('Credit note not found', 404, 'NOT_FOUND')
  if (before.status === 'CANCELLED') throw new AppError(`${before.noteNumber} is already cancelled`, 409, 'ALREADY_CANCELLED')
  // Returned goods leave the store again — refused if they have already gone on.
  if (before.type === 'RETURN' && before.warehouseId) {
    for (const l of before.lines) {
      const parts = l.sizes.length ? l.sizes.map((z) => ({ sizeId: z.sizeId as string | null, qty: Number(z.qty) })) : [{ sizeId: null, qty: Number(l.qty) }]
      for (const p of parts) {
        await recordMovement(tx, {
          itemId: l.itemId,
          warehouseId: before.warehouseId,
          sizeId: p.sizeId,
          transactionType: 'ADJUSTMENT',
          direction: 'OUT',
          qty: p.qty,
          referenceType: 'CREDIT_NOTE_CANCEL',
          referenceId: before.id,
          notes: `Cancelled ${before.noteNumber}: ${reason}`,
        })
      }
    }
  }
  const after = await tx.creditNote.update({
    where: { id: before.id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: userId, cancelReason: reason, onAccount: 0 },
    include: noteInclude,
  })
  if (before.invoiceId) {
    const applied = round2(Number(before.totalAmount) - Number(before.onAccount))
    await tx.salesInvoice.update({ where: { id: before.invoiceId }, data: { creditedAmount: { decrement: applied } } })
    await syncInvoiceFromReceipts(tx, before.invoiceId)
  }
  return { before, after }
}

router.post('/:id/cancel', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(500) }).parse(req.body ?? {})
  const { before, after } = await prisma.$transaction((tx) => cancelCreditNote(tx, req.params.id, req.user!.id, reason), { timeout: 60_000 })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'CreditNote', entityId: after.id, before, after })
  res.json({
    success: true,
    message: `${after.noteNumber} cancelled.${after.type === 'RETURN' ? ' Its goods are out of the store again.' : ''} ${after.invoice?.invoiceNumber ?? 'The invoice'} owes what it did before.`,
    data: after,
  })
})

/** GET /api/sales/credit-notes — filters: q, type, status, customerId, from, to, page, limit. */
router.get('/', async (req: AuthRequest, res) => {
  mustSee(req)
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const and: Prisma.CreditNoteWhereInput[] = []
  const q = text(req.query.q)
  if (q) {
    and.push({
      OR: [
        { noteNumber: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
        { invoice: { invoiceNumber: { contains: q, mode: 'insensitive' } } },
        { reason: { contains: q, mode: 'insensitive' } },
      ],
    })
  }
  const type = text(req.query.type)
  if (type) {
    if (!['RETURN', 'ADJUSTMENT'].includes(type)) throw new AppError(`Unknown type '${type}'`, 400, 'BAD_TYPE')
    and.push({ type })
  }
  const status = text(req.query.status)
  if (status) {
    if (!['ISSUED', 'CANCELLED'].includes(status)) throw new AppError(`Unknown status '${status}'`, 400, 'BAD_STATUS')
    and.push({ status: status as 'ISSUED' | 'CANCELLED' })
  }
  const customerId = text(req.query.customerId)
  if (customerId) and.push({ customerId })
  const from = text(req.query.from)
  const to = text(req.query.to)
  if (from || to) {
    const end = to ? new Date(to) : null
    if (end) end.setDate(end.getDate() + 1)
    and.push({ noteDate: { ...(from && { gte: new Date(from) }), ...(end && { lt: end }) } })
  }
  const where: Prisma.CreditNoteWhereInput = and.length ? { AND: and } : {}
  const [rows, total] = await Promise.all([
    prisma.creditNote.findMany({ where, include: noteInclude, orderBy: [{ noteDate: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
    prisma.creditNote.count({ where }),
  ])
  res.json({
    success: true,
    data: rows.map((r) => ({ ...r, pieces: r.lines.reduce((s, l) => s + Number(l.qty), 0) })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  })
})

router.get('/:id', async (req: AuthRequest, res) => {
  mustSee(req)
  const note = await prisma.creditNote.findUnique({ where: { id: req.params.id }, include: noteInclude })
  if (!note) throw new AppError('Credit note not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: note })
})

/** GET /:id/print — the credit note, GST-wise, as the customer is given it. */
router.get('/:id/print', async (req: AuthRequest, res) => {
  mustSee(req)
  const note = await prisma.creditNote.findUnique({ where: { id: req.params.id }, include: noteInclude })
  if (!note) throw new AppError('Credit note not found', 404, 'NOT_FOUND')
  const header = await getPrintHeader('CN')
  const taxMode = Number(note.igst) > 0 ? 'IGST' : Number(note.cgst) > 0 ? 'CGST_SGST' : 'NONE'
  res.json({
    success: true,
    data: { ...header, note, taxMode, placeOfSupplyState: stateName(note.placeOfSupplyCode), totalInWords: amountInWords(Number(note.totalAmount)) },
  })
})

export default router
