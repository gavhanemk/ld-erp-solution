import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AuthRequest, requirePermission } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
import { amountInWords, getPrintHeader } from '../lib/printData'
import { stateName } from '../lib/gstStates'
import { createSalesOrderSchema, prepareOrder } from './sales.routes'

/**
 * Quotations: a price offered before the customer orders.
 *
 * Optional — a regular buyer usually goes straight to an order — but the
 * first step for a new buyer or a new style, and whenever price or terms
 * change (the business's answer of 9 Oct 2026). Priced exactly as an order
 * is, by the same function, so the GST and totals agree with the order it
 * becomes. Each line keeps the BOM's cost per piece as it stood when quoted,
 * so the margin can be read back later.
 *
 * Draft → Sent → Won (a sales order was made from it) or Lost, with why. A
 * sent quotation past its valid-until date reads as expired. Won is set by
 * the sales order route when an order is saved from the quotation.
 *
 * Mounted at /api/sales/quotations, ahead of /api/sales.
 */

const router = Router()
const MODULE = 'sales'
const round2 = (n: number) => Math.round(n * 100) / 100
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const STATUSES = ['DRAFT', 'SENT', 'WON', 'LOST'] as const

const lineSchema = z.object({
  itemId: z.string().min(1, 'Pick an item'),
  styleCode: z.string().trim().max(50).optional().nullable(),
  color: z.string().trim().max(50).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  qty: z.number().positive('Quantity must be more than zero'),
  unitPrice: z.number().min(0, 'Rate cannot be negative'),
  discount: z.number().min(0).max(100).optional(),
})

export const quoteSchema = z
  .object({
    customerId: z.string().min(1, 'Pick a customer'),
    brandId: z.string().min(1, 'Pick a brand'),
    quoteDate: z.coerce.date().optional(),
    validUntil: z.coerce.date().optional().nullable(),
    isJobWork: z.boolean().optional(),
    customerRef: z.string().trim().max(80).optional().nullable(),
    salesperson: z.string().trim().max(120).optional().nullable(),
    placeOfSupplyCode: z.string().optional().nullable(),
    discountAmount: z.number().min(0).optional(),
    terms: z.string().max(2000).optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
    /** Mark it sent on saving, rather than keep it as a draft. */
    send: z.boolean().optional(),
    lines: z.array(lineSchema).min(1, 'A quotation needs at least one line'),
  })
  .superRefine((d, ctx) => {
    if (d.quoteDate && d.validUntil && d.validUntil < d.quoteDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['validUntil'], message: 'It cannot expire before it is made' })
    }
  })

type QuoteInput = z.infer<typeof quoteSchema>

/**
 * The BOM a quotation prices from, for a style in a colour: the BOM made for
 * that colour, else the one for all colours; an approved BOM ahead of a draft
 * at each step. A draft counts because the price is often set while the BOM
 * is still being worked on, and the quotation goes out before it is approved.
 * The same order is used on the form (pickBom there), so what is shown is
 * what is saved.
 */
type QuoteBom = { status: string; color: string | null; version: string; costPerPiece: unknown; sellingPrice: unknown; marginPercent: unknown }
function pickBom<T extends QuoteBom>(boms: T[], color?: string | null): T | null {
  const wanted = color?.trim().toLowerCase()
  const rank = (b: T) => (b.status === 'APPROVED' ? 0 : 1)
  const sorted = [...boms].sort((a, b) => rank(a) - rank(b))
  return (wanted ? sorted.find((b) => b.color?.trim().toLowerCase() === wanted) : undefined) ?? sorted.find((b) => !b.color?.trim()) ?? null
}

const QUOTE_BOM = {
  where: { isActive: true, status: { in: ['APPROVED', 'DRAFT'] as Array<'APPROVED' | 'DRAFT'> }, OR: [{ costPerPiece: { not: null } }, { sellingPrice: { not: null } }] },
  select: { status: true, color: true, version: true, costPerPiece: true, sellingPrice: true, marginPercent: true },
  orderBy: [{ approvedAt: 'desc' as const }, { updatedAt: 'desc' as const }],
}

/**
 * The BOM's cost and selling price per piece for a quotation line: its style
 * is the style number on the line, else the item's own style. Null when the
 * style has no BOM with a cost or a price.
 */
async function bomPrice(db: Prisma.TransactionClient | typeof prisma, itemId: string | null, styleCode?: string | null, color?: string | null) {
  const item = itemId ? await db.item.findUnique({ where: { id: itemId }, select: { color: true, styleId: true } }) : null
  const styleId =
    (styleCode?.trim() ? (await db.style.findFirst({ where: { code: { equals: styleCode.trim(), mode: 'insensitive' } }, select: { id: true } }))?.id : null) ??
    item?.styleId ??
    null
  if (!styleId) return null
  const bom = pickBom(await db.bOM.findMany({ ...QUOTE_BOM, where: { ...QUOTE_BOM.where, styleId } }), color?.trim() || item?.color || null)
  if (!bom) return null
  return {
    version: bom.version,
    status: bom.status,
    color: bom.color,
    cost: bom.costPerPiece != null ? Number(bom.costPerPiece) : null,
    price: bom.sellingPrice != null ? Number(bom.sellingPrice) : null,
    marginPercent: bom.marginPercent != null ? Number(bom.marginPercent) : null,
  }
}

/** Prices a quotation the way an order is priced, and adds each line's BOM cost. */
async function priceQuote(tx: Prisma.TransactionClient, data: QuoteInput) {
  const { header, lines } = await prepareOrder(
    tx,
    createSalesOrderSchema.parse({
      customerId: data.customerId,
      brandId: data.brandId,
      isJobWork: data.isJobWork,
      placeOfSupplyCode: data.placeOfSupplyCode || null,
      discountAmount: data.discountAmount,
      lines: data.lines.map((l) => ({
        itemId: l.itemId,
        styleCode: l.styleCode ?? null,
        color: l.color ?? null,
        description: l.description ?? null,
        totalQty: l.qty,
        unitPrice: l.unitPrice,
        discount: l.discount,
      })),
    }),
  )
  const costs = await Promise.all(data.lines.map((l) => bomPrice(tx, l.itemId, l.styleCode, l.color)))
  return {
    header: {
      customerId: data.customerId,
      brandId: data.brandId,
      isJobWork: data.isJobWork ?? false,
      customerRef: data.customerRef || null,
      salesperson: data.salesperson || null,
      placeOfSupplyCode: header.placeOfSupplyCode,
      validUntil: data.validUntil ?? null,
      terms: data.terms || null,
      notes: data.notes || null,
      subtotal: header.subtotal,
      discountAmount: header.discountAmount,
      taxableAmount: header.taxableAmount,
      cgst: header.cgst,
      sgst: header.sgst,
      igst: header.igst,
      roundOff: header.roundOff,
      totalAmount: header.totalAmount,
    },
    lines: data.lines.map((l, i) => ({
      itemId: l.itemId,
      styleCode: (lines[i].styleCode as string | null) ?? null,
      color: (lines[i].color as string | null) ?? null,
      description: l.description || null,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discount: l.discount ?? 0,
      gstRate: Number(lines[i].gstRate),
      hsnCode: (lines[i].hsnCode as string | null) ?? null,
      amount: Number(lines[i].amount),
      bomCost: costs[i]?.cost ?? null,
      sortOrder: i,
    })),
  }
}

const quoteInclude = {
  customer: { select: { id: true, code: true, name: true, gstin: true, billingAddress: true, billingCity: true, billingState: true, billingPincode: true, phone: true } },
  brand: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  lines: {
    orderBy: { sortOrder: 'asc' },
    include: { item: { select: { id: true, code: true, name: true, color: true, hsnCode: true, uom: { select: { symbol: true } } } } },
  },
  orders: { select: { id: true, soNumber: true, status: true } },
} satisfies Prisma.SalesQuotationInclude

const startOfToday = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** GET /api/sales/quotations/bom-price?itemId=&styleCode=&color= — the guide shown beside the rate. */
router.get('/bom-price', requirePermission(MODULE, 'view'), async (req, res) => {
  const itemId = text(req.query.itemId)
  if (!itemId) throw new AppError('Say which item', 400, 'NO_ITEM')
  res.json({ success: true, data: await bomPrice(prisma, itemId, text(req.query.styleCode), text(req.query.color)) })
})

/**
 * GET /api/sales/quotations/styles
 *
 * What a quotation line starts from: every active style with its colours,
 * its BOMs' cost and selling price (approved or draft, the form picks the
 * same way pickBom does), and the finished-goods items linked to it, so
 * picking a style and colour fills in the rate and the item to bill.
 */
router.get('/styles', requirePermission(MODULE, 'view'), async (_req, res) => {
  const styles = await prisma.style.findMany({
    where: { isActive: true },
    select: {
      id: true,
      code: true,
      name: true,
      brandType: true,
      category: true,
      colors: true,
      items: { where: { isActive: true, type: 'FINISHED_GOOD' }, select: { id: true, color: true } },
      boms: QUOTE_BOM,
    },
    orderBy: { code: 'asc' },
  })
  res.json({
    success: true,
    data: styles.map((st) => ({
      id: st.id,
      code: st.code,
      name: st.name,
      brandType: st.brandType,
      category: st.category,
      colors: [...new Set([...st.colors, ...st.items.map((i) => i.color).filter((c): c is string => !!c)])],
      items: st.items,
      boms: st.boms.map((b) => ({
        status: b.status,
        color: b.color,
        version: b.version,
        cost: b.costPerPiece != null ? Number(b.costPerPiece) : null,
        price: b.sellingPrice != null ? Number(b.sellingPrice) : null,
      })),
    })),
  })
})

/** GET /api/sales/quotations/summary — the cards over the list. */
router.get('/summary', requirePermission(MODULE, 'view'), async (_req, res) => {
  const today = startOfToday()
  const since = new Date(today.getFullYear(), today.getMonth() - 2, 1)
  const [open, expired, recent] = await Promise.all([
    prisma.salesQuotation.aggregate({ where: { status: 'SENT', OR: [{ validUntil: null }, { validUntil: { gte: today } }] }, _count: true, _sum: { taxableAmount: true } }),
    prisma.salesQuotation.count({ where: { status: 'SENT', validUntil: { lt: today } } }),
    prisma.salesQuotation.groupBy({ by: ['status'], where: { quoteDate: { gte: since }, status: { in: ['WON', 'LOST'] } }, _count: true }),
  ])
  const won = recent.find((r) => r.status === 'WON')?._count ?? 0
  const lost = recent.find((r) => r.status === 'LOST')?._count ?? 0
  res.json({
    success: true,
    data: {
      open: { count: open._count, value: Number(open._sum.taxableAmount ?? 0) },
      expired,
      won,
      lost,
      winRate: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null,
    },
  })
})

/** GET /api/sales/quotations — filters: q, status (or EXPIRED), customerId, from, to, page, limit. */
router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const and: Prisma.SalesQuotationWhereInput[] = []
  const q = text(req.query.q)
  if (q) {
    and.push({
      OR: [
        { quoteNumber: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
        { customerRef: { contains: q, mode: 'insensitive' } },
        { lines: { some: { styleCode: { contains: q, mode: 'insensitive' } } } },
      ],
    })
  }
  const status = text(req.query.status)
  if (status === 'EXPIRED') and.push({ status: 'SENT', validUntil: { lt: startOfToday() } })
  else if (status) {
    if (!(STATUSES as readonly string[]).includes(status)) throw new AppError(`Unknown status '${status}'`, 400, 'BAD_STATUS')
    and.push({ status })
  }
  const customerId = text(req.query.customerId)
  if (customerId) and.push({ customerId })
  const from = text(req.query.from)
  const to = text(req.query.to)
  if (from || to) {
    const end = to ? new Date(to) : null
    if (end) end.setDate(end.getDate() + 1)
    and.push({ quoteDate: { ...(from && { gte: new Date(from) }), ...(end && { lt: end }) } })
  }
  const where: Prisma.SalesQuotationWhereInput = and.length ? { AND: and } : {}
  const [rows, total] = await Promise.all([
    prisma.salesQuotation.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, billingCity: true } },
        brand: { select: { name: true } },
        orders: { select: { id: true, soNumber: true } },
        _count: { select: { lines: true } },
        lines: { select: { qty: true, amount: true, bomCost: true } },
      },
      orderBy: [{ quoteDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.salesQuotation.count({ where }),
  ])
  res.json({
    success: true,
    data: rows.map(({ lines, ...r }) => {
      const costed = lines.filter((l) => l.bomCost != null)
      const cost = costed.reduce((s, l) => s + Number(l.bomCost) * Number(l.qty), 0)
      const value = costed.reduce((s, l) => s + Number(l.amount), 0)
      return {
        ...r,
        pieces: lines.reduce((s, l) => s + Number(l.qty), 0),
        /** Margin over BOM cost on the lines that have one, before the bill discount. */
        marginPercent: value > 0 && costed.length ? Math.round(((value - cost) / value) * 1000) / 10 : null,
      }
    }),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  })
})

router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const quote = await prisma.salesQuotation.findUnique({ where: { id: req.params.id }, include: quoteInclude })
  if (!quote) throw new AppError('Quotation not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: quote })
})

/** GET /api/sales/quotations/:id/print — the quotation sent to the buyer. */
router.get('/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const quote = await prisma.salesQuotation.findUnique({ where: { id: req.params.id }, include: quoteInclude })
  if (!quote) throw new AppError('Quotation not found', 404, 'NOT_FOUND')
  const header = await getPrintHeader('QT')
  const taxMode = Number(quote.igst) > 0 ? 'IGST' : Number(quote.cgst) > 0 ? 'CGST_SGST' : 'NONE'
  res.json({
    success: true,
    data: { ...header, quote, taxMode, placeOfSupplyState: stateName(quote.placeOfSupplyCode), totalInWords: amountInWords(Number(quote.totalAmount)) },
  })
})

/** Saves a quotation inside the caller's transaction. Exported for the checks that roll it back. */
export async function createQuote(tx: Prisma.TransactionClient, data: QuoteInput, userId: string) {
  const { header, lines } = await priceQuote(tx, data)
  const quoteDate = data.quoteDate ?? new Date()
  // Priced and checked first: a refused quotation takes no number.
  const quoteNumber = await nextDocumentNumber(tx, 'QT', quoteDate)
  return tx.salesQuotation.create({
    data: {
      ...header,
      quoteNumber,
      quoteDate,
      status: data.send ? 'SENT' : 'DRAFT',
      sentAt: data.send ? new Date() : null,
      createdById: userId,
      lines: { create: lines },
    },
    include: quoteInclude,
  })
}

router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = quoteSchema.parse(req.body)
  const quote = await prisma.$transaction((tx) => createQuote(tx, data, req.user!.id), { timeout: 30_000 })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'SalesQuotation', entityId: quote.id, after: quote })
  res.status(201).json({ success: true, message: `${quote.quoteNumber} ${quote.status === 'SENT' ? 'saved and marked sent' : 'saved as a draft'}`, data: quote })
})

/** PATCH — a draft or sent quotation changed, until it is won or lost. */
router.patch('/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = quoteSchema.parse(req.body)
  const { before, after } = await prisma.$transaction(
    async (tx) => {
      const before = await tx.salesQuotation.findUnique({ where: { id: req.params.id }, include: quoteInclude })
      if (!before) throw new AppError('Quotation not found', 404, 'NOT_FOUND')
      if (before.status === 'WON' || before.status === 'LOST') {
        throw new AppError(`${before.quoteNumber} is ${before.status.toLowerCase()}, so it can no longer change. Copy it into a new one.`, 409, 'DECIDED')
      }
      const { header, lines } = await priceQuote(tx, data)
      await tx.salesQuotationLine.deleteMany({ where: { quoteId: before.id } })
      const sending = data.send && before.status === 'DRAFT'
      const after = await tx.salesQuotation.update({
        where: { id: before.id },
        data: {
          ...header,
          quoteDate: data.quoteDate ?? before.quoteDate,
          ...(sending ? { status: 'SENT', sentAt: new Date() } : {}),
          lines: { create: lines },
        },
        include: quoteInclude,
      })
      return { before, after }
    },
    { timeout: 30_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'SalesQuotation', entityId: after.id, before, after })
  res.json({ success: true, message: `${after.quoteNumber} saved`, data: after })
})

// POST /:id/sent — handed to the buyer.
router.post('/:id/sent', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const before = await prisma.salesQuotation.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('Quotation not found', 404, 'NOT_FOUND')
  if (before.status !== 'DRAFT') throw new AppError(`${before.quoteNumber} is already ${before.status.toLowerCase()}`, 409, 'NOT_DRAFT')
  const after = await prisma.salesQuotation.update({ where: { id: before.id }, data: { status: 'SENT', sentAt: new Date() }, include: quoteInclude })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'SalesQuotation', entityId: after.id, before, after })
  res.json({ success: true, message: `${after.quoteNumber} marked sent`, data: after })
})

/** Marks a quotation lost inside the caller's transaction. */
export async function loseQuote(tx: Prisma.TransactionClient, id: string, reason: string) {
  const before = await tx.salesQuotation.findUnique({ where: { id } })
  if (!before) throw new AppError('Quotation not found', 404, 'NOT_FOUND')
  if (before.status === 'WON' || before.status === 'LOST') throw new AppError(`${before.quoteNumber} is already ${before.status.toLowerCase()}`, 409, 'DECIDED')
  return tx.salesQuotation.update({ where: { id }, data: { status: 'LOST', decidedAt: new Date(), lostReason: reason }, include: quoteInclude })
}

// POST /:id/lost — the buyer said no; why is kept for the win/loss report.
router.post('/:id/lost', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Say why, in a few words').max(500) }).parse(req.body ?? {})
  const after = await prisma.$transaction((tx) => loseQuote(tx, req.params.id, reason))
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'SalesQuotation', entityId: after.id, after })
  res.json({ success: true, message: `${after.quoteNumber} marked lost`, data: after })
})

export default router
