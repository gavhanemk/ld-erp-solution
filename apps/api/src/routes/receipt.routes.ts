import { Router } from 'express'
import type { PaymentMode, PaymentStatus, Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AuthRequest, userCan } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
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
import { planAllocations, syncInvoiceFromReceipts, writeAllocations } from '../services/salesReceipt.service'

/**
 * Payments received from customers.
 *
 * One receipt is one sum of money in — an NEFT, a cheque, cash across the
 * counter — and it can settle several of the customer's invoices at once,
 * the way buyers actually pay. What is not applied to an invoice stays on
 * account as an advance, and is applied later as invoices are raised.
 *
 * TDS the customer deducted settles an invoice exactly as cash does: they
 * paid it to the government for us. A cheque or a post-dated cheque settles
 * its invoices when it is recorded, and is marked cleared when the bank
 * credits it. A cheque that bounces, or a receipt put in by mistake, is
 * reversed with a reason — never deleted — and its invoices are owed again.
 *
 * The receipt number is taken after every check, so a refused receipt uses
 * none. Sales and Accounts both work here: either module's rights will do.
 *
 * Mounted at /api/sales/receipts, ahead of /api/sales.
 */

const router = Router()

const round2 = (n: number) => Math.round(n * 100) / 100
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Sales or Accounts, whichever the person has, may do it. */
function must(req: AuthRequest, action: string, what: string) {
  if (!userCan(req.user, 'sales', action) && !userCan(req.user, 'accounts', action)) {
    throw new AppError(`You do not have permission to ${what}`, 403, 'FORBIDDEN')
  }
}

const MODES = ['CASH', 'CHEQUE', 'NEFT', 'RTGS', 'UPI', 'PDC'] as const
/** Where a bare amount is not enough to find the money at the bank. */
const NEEDS_REFERENCE = new Set(['NEFT', 'RTGS', 'UPI'])
const IS_CHEQUE = new Set(['CHEQUE', 'PDC'])

const money = (what: string) =>
  z
    .number({ invalid_type_error: `${what} has to be an amount` })
    .min(0, `${what} cannot be less than zero`)
    .max(99_999_999, 'That amount looks like a typo')

const allocationSchema = z.object({
  invoiceId: z.string().min(1, 'Pick the invoice'),
  amount: money('The amount applied'),
  tdsAmount: money('TDS').optional(),
})

const allocationList = z
  .array(allocationSchema)
  .max(200)
  .optional()
  .superRefine((list, ctx) => {
    const ids = (list ?? []).map((a) => a.invoiceId)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The same invoice appears twice' })
    }
  })

export const receiptSchema = z
  .object({
    customerId: z.string().min(1, 'Pick the customer'),
    receiptDate: z.coerce.date().optional(),
    mode: z.enum(MODES, { required_error: 'Say how it was paid', invalid_type_error: 'Say how it was paid' }),
    /** The account it went into. Required for a bank transfer; none for cash. */
    bankAccountId: z.string().optional().nullable(),
    referenceNo: z.string().trim().max(60).optional().nullable(),
    chequeNo: z.string().trim().max(40).optional().nullable(),
    chequeDate: z.coerce.date().optional().nullable(),
    amount: money('The amount received').refine((n) => n > 0, 'A receipt has to be more than zero'),
    notes: z.string().max(1000).optional().nullable(),
    allocations: allocationList,
  })
  .superRefine((d, ctx) => {
    if (d.receiptDate && d.receiptDate > new Date()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['receiptDate'], message: 'A receipt cannot be dated in the future' })
    }
    if (NEEDS_REFERENCE.has(d.mode) && !d.referenceNo?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['referenceNo'], message: 'Put the UTR or transaction reference in' })
    }
    if (NEEDS_REFERENCE.has(d.mode) && !d.bankAccountId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bankAccountId'], message: 'Say which account the money came into' })
    }
    if (IS_CHEQUE.has(d.mode) && !d.chequeNo?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chequeNo'], message: 'Put the cheque number in' })
    }
    if (IS_CHEQUE.has(d.mode) && !d.chequeDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chequeDate'], message: 'Put the date written on the cheque' })
    }
    if (!IS_CHEQUE.has(d.mode) && (d.chequeNo?.trim() || d.chequeDate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chequeNo'], message: 'Cheque details only belong on a cheque' })
    }
    const applied = round2((d.allocations ?? []).reduce((s, a) => s + a.amount, 0))
    if (applied > round2(d.amount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocations'],
        message: `₹${applied.toFixed(2)} is applied to invoices, more than the ₹${d.amount.toFixed(2)} received`,
      })
    }
  })

const receiptInclude = {
  customer: { select: { id: true, code: true, name: true, gstin: true, billingAddress: true, billingCity: true, billingState: true, billingPincode: true, phone: true } },
  bankAccount: { select: { id: true, accountName: true, bankName: true } },
  allocations: {
    orderBy: { createdAt: 'asc' },
    include: { invoice: { select: { id: true, invoiceNumber: true, invoiceDate: true, totalAmount: true, balanceAmount: true } } },
  },
  createdBy: { select: { id: true, name: true } },
  reversedBy: { select: { id: true, name: true } },
  _count: { select: { attachments: true } },
} satisfies Prisma.PaymentReceiptInclude

const startOfToday = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** Days past due, from the due date where there is one and the invoice date where not. */
function daysOverdue(inv: { dueDate: Date | null; invoiceDate: Date }) {
  const ref = new Date(inv.dueDate ?? inv.invoiceDate)
  ref.setHours(0, 0, 0, 0)
  return Math.floor((startOfToday().getTime() - ref.getTime()) / 86_400_000)
}

type Bucket = 'notDue' | 'd30' | 'd60' | 'd90' | 'over90'
const bucketOf = (days: number): Bucket =>
  days <= 0 ? 'notDue' : days <= 30 ? 'd30' : days <= 60 ? 'd60' : days <= 90 ? 'd90' : 'over90'

/**
 * GET /api/sales/receipts/open-invoices?customerId=
 *
 * What the receipt form settles: the customer's invoices still owed, oldest
 * first, and what they already hold on account.
 */
router.get('/open-invoices', async (req: AuthRequest, res) => {
  must(req, 'view', 'view receipts')
  const customerId = text(req.query.customerId)
  if (!customerId) throw new AppError('Pick the customer', 400, 'NO_CUSTOMER')
  const [invoices, onAccount] = await Promise.all([
    prisma.salesInvoice.findMany({
      where: { customerId, status: { in: ['UNPAID', 'PARTIAL'] } },
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        dueDate: true,
        totalAmount: true,
        paidAmount: true,
        tdsAmount: true,
        balanceAmount: true,
        status: true,
        so: { select: { soNumber: true, customerPORef: true } },
      },
      orderBy: [{ invoiceDate: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.paymentReceipt.aggregate({ where: { customerId, status: 'POSTED' }, _sum: { onAccount: true } }),
  ])
  res.json({
    success: true,
    data: {
      invoices: invoices.map((i) => ({ ...i, daysOverdue: Math.max(0, daysOverdue(i)) })),
      onAccount: round2(Number(onAccount._sum.onAccount ?? 0)),
    },
  })
})

/**
 * GET /api/sales/receipts/outstanding?q=&overdue=1
 *
 * What each customer owes, aged: not yet due, 1–30, 31–60, 61–90 and over 90
 * days past due, less what they hold on account, with their invoices for the
 * row that is opened. Biggest first.
 */
router.get('/outstanding', async (req: AuthRequest, res) => {
  must(req, 'view', 'view what customers owe')
  const q = text(req.query.q)
  const onlyOverdue = req.query.overdue === '1'
  const [invoices, advances] = await Promise.all([
    prisma.salesInvoice.findMany({
      where: {
        status: { in: ['UNPAID', 'PARTIAL'] },
        ...(q ? { customer: { name: { contains: q, mode: 'insensitive' } } } : {}),
      },
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        dueDate: true,
        totalAmount: true,
        balanceAmount: true,
        status: true,
        so: { select: { soNumber: true } },
        customer: {
          select: { id: true, code: true, name: true, phone: true, billingCity: true, shippingCity: true, creditDays: true, creditLimit: true },
        },
      },
      orderBy: [{ dueDate: 'asc' }, { invoiceDate: 'asc' }],
    }),
    prisma.paymentReceipt.groupBy({
      by: ['customerId'],
      where: { status: 'POSTED', onAccount: { gt: 0 }, ...(q ? { customer: { name: { contains: q, mode: 'insensitive' } } } : {}) },
      _sum: { onAccount: true },
    }),
  ])

  type Row = {
    customer: (typeof invoices)[number]['customer']
    invoices: Array<Omit<(typeof invoices)[number], 'customer'> & { daysOverdue: number }>
    buckets: Record<Bucket, number>
    total: number
    overdue: number
    onAccount: number
  }
  const rows = new Map<string, Row>()
  const blank = (): Record<Bucket, number> => ({ notDue: 0, d30: 0, d60: 0, d90: 0, over90: 0 })
  for (const { customer, ...inv } of invoices) {
    const row = rows.get(customer.id) ?? { customer, invoices: [], buckets: blank(), total: 0, overdue: 0, onAccount: 0 }
    const days = daysOverdue(inv)
    const balance = Number(inv.balanceAmount)
    row.invoices.push({ ...inv, daysOverdue: Math.max(0, days) })
    row.buckets[bucketOf(days)] += balance
    row.total += balance
    if (days > 0) row.overdue += balance
    rows.set(customer.id, row)
  }
  // A customer with only money on account still shows: it is owed back, or due to be applied.
  const missing = advances.filter((a) => !rows.has(a.customerId)).map((a) => a.customerId)
  if (missing.length) {
    const customers = await prisma.customer.findMany({
      where: { id: { in: missing } },
      select: { id: true, code: true, name: true, phone: true, billingCity: true, shippingCity: true, creditDays: true, creditLimit: true },
    })
    for (const c of customers) rows.set(c.id, { customer: c, invoices: [], buckets: blank(), total: 0, overdue: 0, onAccount: 0 })
  }
  for (const a of advances) {
    const row = rows.get(a.customerId)
    if (row) row.onAccount = Number(a._sum.onAccount ?? 0)
  }

  const data = [...rows.values()]
    .map((r) => ({
      ...r,
      total: round2(r.total),
      overdue: round2(r.overdue),
      onAccount: round2(r.onAccount),
      net: round2(r.total - r.onAccount),
      buckets: Object.fromEntries(Object.entries(r.buckets).map(([k, v]) => [k, round2(v)])) as Record<Bucket, number>,
    }))
    .filter((r) => !onlyOverdue || r.overdue > 0)
    .sort((a, b) => b.net - a.net)

  const sum = (f: (r: (typeof data)[number]) => number) => round2(data.reduce((s, r) => s + f(r), 0))
  res.json({
    success: true,
    data,
    summary: {
      customers: data.length,
      total: sum((r) => r.total),
      overdue: sum((r) => r.overdue),
      onAccount: sum((r) => r.onAccount),
      buckets: {
        notDue: sum((r) => r.buckets.notDue),
        d30: sum((r) => r.buckets.d30),
        d60: sum((r) => r.buckets.d60),
        d90: sum((r) => r.buckets.d90),
        over90: sum((r) => r.buckets.over90),
      },
    },
  })
})

/** GET /api/sales/receipts/summary — the cards over the page. */
router.get('/summary', async (req: AuthRequest, res) => {
  must(req, 'view', 'view receipts')
  const today = startOfToday()
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const open = { status: { in: ['UNPAID', 'PARTIAL'] as Array<'UNPAID' | 'PARTIAL'> } }
  const [owed, overdue, month, cheques, advance] = await Promise.all([
    prisma.salesInvoice.aggregate({ where: open, _sum: { balanceAmount: true }, _count: true }),
    prisma.salesInvoice.aggregate({ where: { ...open, dueDate: { lt: today } }, _sum: { balanceAmount: true }, _count: true }),
    prisma.paymentReceipt.aggregate({ where: { status: 'POSTED', receiptDate: { gte: monthStart } }, _sum: { amount: true }, _count: true }),
    prisma.paymentReceipt.aggregate({
      where: { status: 'POSTED', mode: { in: ['CHEQUE', 'PDC'] }, isChequeCleared: false },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.paymentReceipt.aggregate({ where: { status: 'POSTED', onAccount: { gt: 0 } }, _sum: { onAccount: true }, _count: true }),
  ])
  res.json({
    success: true,
    data: {
      outstanding: { count: owed._count, amount: Number(owed._sum.balanceAmount ?? 0) },
      overdue: { count: overdue._count, amount: Number(overdue._sum.balanceAmount ?? 0) },
      thisMonth: { count: month._count, amount: Number(month._sum.amount ?? 0) },
      chequesToClear: { count: cheques._count, amount: Number(cheques._sum.amount ?? 0) },
      onAccount: { count: advance._count, amount: Number(advance._sum.onAccount ?? 0) },
    },
  })
})

/** GET /api/sales/receipts — filters: q, customerId, mode, status, from, to, onAccount=1, uncleared=1, page, limit. */
router.get('/', async (req: AuthRequest, res) => {
  must(req, 'view', 'view receipts')
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
  const and: Prisma.PaymentReceiptWhereInput[] = []
  const q = text(req.query.q)
  if (q) {
    and.push({
      OR: [
        { receiptNumber: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
        { referenceNo: { contains: q, mode: 'insensitive' } },
        { chequeNo: { contains: q, mode: 'insensitive' } },
        { allocations: { some: { invoice: { invoiceNumber: { contains: q, mode: 'insensitive' } } } } },
      ],
    })
  }
  const customerId = text(req.query.customerId)
  if (customerId) and.push({ customerId })
  const mode = text(req.query.mode)
  if (mode) {
    if (!(MODES as readonly string[]).includes(mode)) throw new AppError(`Unknown mode '${mode}'`, 400, 'BAD_MODE')
    and.push({ mode: mode as PaymentMode })
  }
  const status = text(req.query.status)
  if (status) {
    if (!['POSTED', 'REVERSED'].includes(status)) throw new AppError(`Unknown status '${status}'`, 400, 'BAD_STATUS')
    and.push({ status: status as PaymentStatus })
  }
  if (req.query.onAccount === '1') and.push({ status: 'POSTED', onAccount: { gt: 0 } })
  if (req.query.uncleared === '1') and.push({ status: 'POSTED', mode: { in: ['CHEQUE', 'PDC'] }, isChequeCleared: false })
  const from = text(req.query.from)
  const to = text(req.query.to)
  if (from || to) {
    const end = to ? new Date(to) : null
    if (end) end.setDate(end.getDate() + 1)
    and.push({ receiptDate: { ...(from && { gte: new Date(from) }), ...(end && { lt: end }) } })
  }
  const where: Prisma.PaymentReceiptWhereInput = and.length ? { AND: and } : {}
  const [rows, total] = await Promise.all([
    prisma.paymentReceipt.findMany({
      where,
      include: receiptInclude,
      orderBy: [{ receiptDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.paymentReceipt.count({ where }),
  ])
  res.json({ success: true, data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
})

// GET /api/sales/receipts/:id
router.get('/:id', async (req: AuthRequest, res) => {
  must(req, 'view', 'view receipts')
  const receipt = await prisma.paymentReceipt.findUnique({ where: { id: req.params.id }, include: receiptInclude })
  if (!receipt) throw new AppError('Receipt not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: receipt })
})

/** GET /api/sales/receipts/:id/print — the receipt the customer is given. */
router.get('/:id/print', async (req: AuthRequest, res) => {
  must(req, 'view', 'view receipts')
  const receipt = await prisma.paymentReceipt.findUnique({ where: { id: req.params.id }, include: receiptInclude })
  if (!receipt) throw new AppError('Receipt not found', 404, 'NOT_FOUND')
  const header = await getPrintHeader('RCPT')
  res.json({ success: true, data: { ...header, receipt, amountInWords: amountInWords(Number(receipt.amount)) } })
})

/** Checks an account money is said to have gone into. */
async function checkAccount(tx: Prisma.TransactionClient, bankAccountId: string | null | undefined) {
  if (!bankAccountId) return
  const account = await tx.bankAccount.findUnique({ where: { id: bankAccountId }, select: { accountName: true, isActive: true } })
  if (!account) throw new AppError('That account no longer exists', 400, 'BAD_ACCOUNT')
  if (!account.isActive) throw new AppError(`${account.accountName} is closed. Pick the account the money came into.`, 400, 'ACCOUNT_CLOSED')
}

type ReceiptInput = z.infer<typeof receiptSchema>

/** Records a receipt inside the caller's transaction. Exported for the checks that roll it back. */
export async function createReceipt(tx: Prisma.TransactionClient, data: ReceiptInput, userId: string) {
  const customer = await tx.customer.findUnique({ where: { id: data.customerId }, select: { id: true, name: true } })
  if (!customer) throw new AppError('That customer does not exist', 400, 'BAD_CUSTOMER')
  await checkAccount(tx, data.bankAccountId)
  const when = data.receiptDate ?? new Date()
  const amount = round2(data.amount)
  // Every check before anything is written, so a refused receipt takes no number.
  const planned = await planAllocations(tx, customer.id, data.allocations ?? [])
  const cash = round2(planned.reduce((s, a) => s + a.amount, 0))
  const tds = round2(planned.reduce((s, a) => s + a.tdsAmount, 0))
  const receiptNumber = await nextDocumentNumber(tx, 'RCPT', when)

  const created = await tx.paymentReceipt.create({
    data: {
      receiptNumber,
      customerId: customer.id,
      receiptDate: when,
      amount,
      mode: data.mode,
      bankAccountId: data.bankAccountId || null,
      referenceNo: data.referenceNo?.trim() || null,
      chequeNo: data.chequeNo?.trim() || null,
      chequeDate: data.chequeDate ?? null,
      // Money that is not a cheque is in the bank already.
      isChequeCleared: !IS_CHEQUE.has(data.mode),
      clearedAt: IS_CHEQUE.has(data.mode) ? null : when,
      notes: data.notes ?? null,
      tdsAmount: tds,
      onAccount: round2(amount - cash),
      createdById: userId,
    },
  })
  await writeAllocations(tx, created.id, planned)
  return tx.paymentReceipt.findUniqueOrThrow({ where: { id: created.id }, include: receiptInclude })
}

/** POST /api/sales/receipts */
router.post('/', async (req: AuthRequest, res) => {
  must(req, 'create', 'record receipts')
  const data = receiptSchema.parse(req.body)
  const receipt = await prisma.$transaction((tx) => createReceipt(tx, data, req.user!.id), { timeout: 30_000 })
  await writeAuditLog(req, { module: 'sales', action: 'CREATE', entityType: 'PaymentReceipt', entityId: receipt.id, after: receipt })
  const settled = receipt.allocations.map((a) => a.invoice.invoiceNumber)
  const left = Number(receipt.onAccount)
  res.status(201).json({
    success: true,
    message: `${receipt.receiptNumber}: ₹${Number(receipt.amount).toLocaleString('en-IN')} from ${receipt.customer.name}${
      settled.length ? ` against ${settled.join(', ')}` : ''
    }${left > 0 ? `${settled.length ? ',' : ''} ₹${left.toLocaleString('en-IN')} kept on account` : ''}.`,
    data: receipt,
  })
})

/** Applies money held on account to invoices, inside the caller's transaction. */
export async function allocateReceipt(
  tx: Prisma.TransactionClient,
  id: string,
  allocations: Array<{ invoiceId: string; amount: number; tdsAmount?: number }>,
) {
  const receipt = await tx.paymentReceipt.findUnique({ where: { id }, select: { id: true, receiptNumber: true, customerId: true, status: true, onAccount: true, tdsAmount: true } })
  if (!receipt) throw new AppError('Receipt not found', 404, 'NOT_FOUND')
  if (receipt.status !== 'POSTED') throw new AppError(`${receipt.receiptNumber} is reversed`, 409, 'REVERSED')
  const wanted = round2(allocations.reduce((s, a) => s + a.amount, 0))
  if (wanted > Number(receipt.onAccount)) {
    throw new AppError(
      `Only ₹${Number(receipt.onAccount).toFixed(2)} of ${receipt.receiptNumber} is on account; ₹${wanted.toFixed(2)} was applied`,
      400,
      'MORE_THAN_ON_ACCOUNT',
    )
  }
  const planned = await planAllocations(tx, receipt.customerId, allocations)
  if (!planned.length) throw new AppError('Put an amount against at least one invoice', 400, 'NOTHING_APPLIED')
  const applied = await writeAllocations(tx, receipt.id, planned)
  await tx.paymentReceipt.update({
    where: { id: receipt.id },
    data: { onAccount: round2(Number(receipt.onAccount) - applied.cash), tdsAmount: round2(Number(receipt.tdsAmount) + applied.tds) },
  })
  return tx.paymentReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: receiptInclude })
}

/** POST /api/sales/receipts/:id/allocate — an advance applied to invoices raised since. */
router.post('/:id/allocate', async (req: AuthRequest, res) => {
  must(req, 'create', 'apply receipts')
  const { allocations } = z.object({ allocations: allocationList }).parse(req.body)
  const after = await prisma.$transaction((tx) => allocateReceipt(tx, req.params.id, allocations ?? []), { timeout: 30_000 })
  await writeAuditLog(req, { module: 'sales', action: 'UPDATE', entityType: 'PaymentReceipt', entityId: after.id, after })
  res.json({
    success: true,
    message: `${after.receiptNumber} applied.${Number(after.onAccount) > 0 ? ` ₹${Number(after.onAccount).toLocaleString('en-IN')} still on account.` : ''}`,
    data: after,
  })
})

/** POST /api/sales/receipts/:id/cleared — the bank has credited the cheque. */
router.post('/:id/cleared', async (req: AuthRequest, res) => {
  must(req, 'edit', 'mark cheques cleared')
  const { clearedAt } = z.object({ clearedAt: z.coerce.date().optional() }).parse(req.body ?? {})
  const before = await prisma.paymentReceipt.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('Receipt not found', 404, 'NOT_FOUND')
  if (!IS_CHEQUE.has(before.mode)) throw new AppError(`${before.receiptNumber} is not a cheque`, 409, 'NOT_A_CHEQUE')
  if (before.status !== 'POSTED') throw new AppError(`${before.receiptNumber} is reversed`, 409, 'REVERSED')
  if (before.isChequeCleared) throw new AppError(`${before.receiptNumber} is already cleared`, 409, 'ALREADY_CLEARED')
  const after = await prisma.paymentReceipt.update({
    where: { id: before.id },
    data: { isChequeCleared: true, clearedAt: clearedAt ?? new Date() },
    include: receiptInclude,
  })
  await writeAuditLog(req, { module: 'sales', action: 'UPDATE', entityType: 'PaymentReceipt', entityId: after.id, before, after })
  res.json({ success: true, message: `Cheque ${after.chequeNo ?? ''} on ${after.receiptNumber} marked cleared.`, data: after })
})

/** Reverses a receipt inside the caller's transaction: its invoices are owed again. */
export async function reverseReceipt(tx: Prisma.TransactionClient, id: string, userId: string, reason: string) {
  const before = await tx.paymentReceipt.findUnique({ where: { id }, include: { allocations: { select: { invoiceId: true } } } })
  if (!before) throw new AppError('Receipt not found', 404, 'NOT_FOUND')
  if (before.status === 'REVERSED') throw new AppError(`${before.receiptNumber} is already reversed`, 409, 'ALREADY_REVERSED')
  await tx.paymentReceipt.update({
    where: { id: before.id },
    data: { status: 'REVERSED', reversedAt: new Date(), reversedById: userId, reversalReason: reason },
  })
  for (const a of before.allocations) await syncInvoiceFromReceipts(tx, a.invoiceId)
  return tx.paymentReceipt.findUniqueOrThrow({ where: { id: before.id }, include: receiptInclude })
}

/**
 * POST /api/sales/receipts/:id/reverse
 *
 * A bounced cheque, a duplicate entry, money that was never ours: the receipt
 * stays on file, stops settling its invoices, and they are owed again. Its
 * number is not given out again.
 */
router.post('/:id/reverse', async (req: AuthRequest, res) => {
  must(req, 'approve', 'reverse receipts')
  const { reason } = z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(500) }).parse(req.body ?? {})
  const after = await prisma.$transaction((tx) => reverseReceipt(tx, req.params.id, req.user!.id, reason))
  await writeAuditLog(req, { module: 'sales', action: 'UPDATE', entityType: 'PaymentReceipt', entityId: after.id, after })
  const owedAgain = after.allocations.map((a) => a.invoice.invoiceNumber)
  res.json({
    success: true,
    message: `${after.receiptNumber} reversed.${owedAgain.length ? ` ${owedAgain.join(', ')} ${owedAgain.length === 1 ? 'is' : 'are'} owed again.` : ''}`,
    data: after,
  })
})

// ── Files against a receipt: the bank advice, the cheque, the UTR ───────────

const fileInclude = { uploadedBy: { select: { id: true, name: true } } }

router.get('/:id/attachments', async (req: AuthRequest, res) => {
  must(req, 'view', 'view receipts')
  const rows = await prisma.paymentReceiptAttachment.findMany({ where: { receiptId: req.params.id }, include: fileInclude, orderBy: { createdAt: 'asc' } })
  res.json({ success: true, data: rows })
})

router.post('/:id/attachments/upload-url', async (req: AuthRequest, res) => {
  must(req, 'create', 'attach files to receipts')
  const { fileName } = z
    .object({
      fileName: z.string().min(1, 'The file needs a name').max(255),
      sizeBytes: z.number().int().positive('That file is empty').max(MAX_FILE_BYTES, `Files have to be ${MAX_FILE_BYTES / 1024 / 1024}MB or smaller`),
    })
    .parse(req.body)
  const receipt = await prisma.paymentReceipt.findUnique({ where: { id: req.params.id }, select: { id: true, receiptNumber: true } })
  if (!receipt) throw new AppError('Receipt not found', 404, 'NOT_FOUND')
  if ((await prisma.paymentReceiptAttachment.count({ where: { receiptId: receipt.id } })) >= MAX_FILES_PER_DOCUMENT) {
    throw new AppError(`${receipt.receiptNumber} already has ${MAX_FILES_PER_DOCUMENT} files. Remove one first.`, 409, 'TOO_MANY_FILES')
  }
  const path = storagePathFor('sales-receipts', receipt.id, fileName)
  const { uploadUrl } = await signedUploadUrl(path)
  res.json({ success: true, data: { uploadUrl, storagePath: path, fileName } })
})

router.post('/:id/attachments', async (req: AuthRequest, res) => {
  must(req, 'create', 'attach files to receipts')
  const { fileName, storagePath } = z.object({ fileName: z.string().min(1).max(255), storagePath: z.string().min(1) }).parse(req.body)
  const receipt = await prisma.paymentReceipt.findUnique({ where: { id: req.params.id }, select: { id: true } })
  if (!receipt) throw new AppError('Receipt not found', 404, 'NOT_FOUND')
  if (!storagePath.startsWith(`sales-receipts/${receipt.id}/`)) {
    throw new AppError('That file does not belong to this receipt', 400, 'WRONG_DOCUMENT')
  }
  const { sizeBytes, mimeType } = await statObject(storagePath)
  if (sizeBytes > MAX_FILE_BYTES) {
    await removeObject(storagePath).catch(() => {})
    throw new AppError(`That file is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024}MB.`, 400, 'FILE_TOO_LARGE')
  }
  const file = await prisma.paymentReceiptAttachment.create({
    data: { receiptId: receipt.id, fileName, storagePath, mimeType, sizeBytes, uploadedById: req.user!.id },
    include: fileInclude,
  })
  await writeAuditLog(req, { module: 'sales', action: 'CREATE', entityType: 'PaymentReceiptAttachment', entityId: file.id, after: file })
  res.status(201).json({ success: true, data: file })
})

router.get('/attachments/:id/link', async (req: AuthRequest, res) => {
  must(req, 'view', 'view receipts')
  const file = await prisma.paymentReceiptAttachment.findUnique({ where: { id: req.params.id } })
  if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')
  res.json({ success: true, data: { url: await signedDownloadUrl(file.storagePath), fileName: file.fileName } })
})

router.delete('/attachments/:id', async (req: AuthRequest, res) => {
  must(req, 'edit', 'remove files from receipts')
  const file = await prisma.paymentReceiptAttachment.findUnique({ where: { id: req.params.id }, include: fileInclude })
  if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')
  await prisma.paymentReceiptAttachment.delete({ where: { id: file.id } })
  await removeObject(file.storagePath).catch(() => {})
  await writeAuditLog(req, { module: 'sales', action: 'DELETE', entityType: 'PaymentReceiptAttachment', entityId: file.id, before: file })
  res.json({ success: true, message: `${file.fileName} removed.` })
})

export default router
