import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'

/**
 * Debit notes — what the mill claims back from a supplier.
 *
 * Goods returned, a rate charged above what was agreed, a shortage against
 * the challan. The bill form already raises one automatically when a supplier
 * bills above the order's rate, and until now that was the end of it: the
 * note existed in the database and nothing could list it, read it or send it.
 * A claim nobody can see is a claim nobody makes.
 *
 * Its own file rather than more of `purchase.routes.ts`, which is already
 * four and a half thousand lines. Mounted at `/api/purchase/debit-notes`
 * ahead of the purchase router, so it inherits the same permission module.
 */

const MODULE = 'purchase'
const router = Router()

const debitNoteInclude = {
  supplier: { select: { id: true, code: true, name: true, gstin: true } },
  bill: { select: { id: true, billNumber: true, supplierInvoiceNo: true, billDate: true } },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    select: {
      id: true,
      description: true,
      hsnCode: true,
      qty: true,
      unitPrice: true,
      taxableValue: true,
      gstRate: true,
      amount: true,
      item: { select: { id: true, code: true, name: true, uom: { select: { symbol: true } } } },
    },
  },
} satisfies Prisma.DebitNoteInclude

router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const { q, status, supplierId, from, to } = req.query as Record<string, string | undefined>
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

  const where: Prisma.DebitNoteWhereInput = {
    ...(status ? { status: status as Prisma.EnumNoteStatusFilter['equals'] } : {}),
    ...(supplierId ? { supplierId } : {}),
    // Inclusive at both ends — `to` read as midnight silently drops everything
    // raised that afternoon.
    ...(from || to
      ? {
          noteDate: {
            ...(from ? { gte: new Date(`${from}T00:00:00`) } : {}),
            ...(to ? { lte: new Date(`${to}T23:59:59.999`) } : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { noteNumber: { contains: q, mode: 'insensitive' } },
            { reason: { contains: q, mode: 'insensitive' } },
            { supplier: { name: { contains: q, mode: 'insensitive' } } },
            { bill: { billNumber: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }

  const [rows, total] = await Promise.all([
    prisma.debitNote.findMany({
      where,
      include: debitNoteInclude,
      orderBy: [{ noteDate: 'desc' }, { noteNumber: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.debitNote.count({ where }),
  ])

  const summary = await prisma.debitNote.groupBy({
    by: ['status'],
    _sum: { totalAmount: true },
    _count: { _all: true },
  })

  res.json({
    success: true,
    data: rows,
    summary: Object.fromEntries(
      summary.map((s) => [
        s.status,
        { count: s._count._all, amount: Number(s._sum.totalAmount ?? 0) },
      ])
    ),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  })
})

router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const note = await prisma.debitNote.findUnique({
    where: { id: req.params.id },
    include: debitNoteInclude,
  })
  if (!note) throw new AppError('That debit note no longer exists', 404, 'NOT_FOUND')
  res.json({ success: true, data: note })
})

/**
 * Sends it.
 *
 * A debit note is a demand for money from somebody the mill trades with, so
 * it leaves the building because a person decided it should — never because a
 * rate comparison did. That is why the bill form raises these as drafts, and
 * why sending one is a separate press by a separate hand.
 */
router.patch('/:id/issue', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const note = await prisma.$transaction(async (tx) => {
    const before = await tx.debitNote.findUnique({
      where: { id: req.params.id },
      select: { id: true, noteNumber: true, status: true, totalAmount: true },
    })
    if (!before) throw new AppError('That debit note no longer exists', 404, 'NOT_FOUND')
    if (before.status !== 'DRAFT') {
      throw new AppError(
        `${before.noteNumber} is already ${before.status.toLowerCase()} and cannot be sent again.`,
        400,
        'NOT_A_DRAFT'
      )
    }
    if (Number(before.totalAmount) <= 0) {
      throw new AppError(
        `${before.noteNumber} claims nothing. There is nothing to send.`,
        400,
        'NOTHING_CLAIMED'
      )
    }
    return tx.debitNote.update({
      where: { id: before.id },
      data: { status: 'ISSUED' },
      include: debitNoteInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'DebitNote',
    entityId: note.id,
    after: note,
  })

  res.json({
    success: true,
    data: note,
    message: `${note.noteNumber} sent to ${note.supplier.name}.`,
  })
})

/** The supplier has credited it. */
router.patch('/:id/settle', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const note = await prisma.$transaction(async (tx) => {
    const before = await tx.debitNote.findUnique({
      where: { id: req.params.id },
      select: { id: true, noteNumber: true, status: true },
    })
    if (!before) throw new AppError('That debit note no longer exists', 404, 'NOT_FOUND')
    if (before.status !== 'ISSUED') {
      throw new AppError(
        `Only a note the supplier has been sent can be settled. ${before.noteNumber} is ${before.status.toLowerCase()}.`,
        400,
        'NOT_ISSUED'
      )
    }
    return tx.debitNote.update({
      where: { id: before.id },
      data: { status: 'ADJUSTED' },
      include: debitNoteInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'DebitNote',
    entityId: note.id,
    after: note,
  })

  res.json({ success: true, data: note, message: `${note.noteNumber} marked settled.` })
})

router.patch('/:id/cancel', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = z
    .object({ reason: z.string().trim().max(500).optional() })
    .parse(req.body ?? {})

  const note = await prisma.$transaction(async (tx) => {
    const before = await tx.debitNote.findUnique({
      where: { id: req.params.id },
      select: { id: true, noteNumber: true, status: true, notes: true },
    })
    if (!before) throw new AppError('That debit note no longer exists', 404, 'NOT_FOUND')
    if (before.status === 'CANCELLED') {
      throw new AppError(`${before.noteNumber} is already cancelled.`, 409, 'ALREADY_CANCELLED')
    }
    // A note the supplier has already credited is part of settled accounts.
    if (before.status === 'ADJUSTED') {
      throw new AppError(
        `${before.noteNumber} has been settled by the supplier and can no longer be cancelled.`,
        400,
        'ALREADY_SETTLED'
      )
    }
    return tx.debitNote.update({
      where: { id: before.id },
      data: {
        status: 'CANCELLED',
        notes: reason
          ? `${before.notes ? `${before.notes}\n` : ''}Cancelled: ${reason}`
          : before.notes,
      },
      include: debitNoteInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'DebitNote',
    entityId: note.id,
    after: note,
  })

  res.json({ success: true, data: note, message: `${note.noteNumber} cancelled.` })
})

export default router
