import { Router } from 'express'
import { z } from 'zod'
import { prisma, type Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { generateGarments, normaliseGarmentCode } from '../services/garment.service'
import { addToChallan, dispatchScanned, moveGarments, removeFromChallan, requestScrap, returnGarments } from '../services/garmentMove.service'
import { barcodesFor, skuKey } from '../services/barcode.service'
import { piecesWhere } from '../services/trace.service'

/*
 * Garment tags: one QR label per finished piece.
 *
 * An order is switched on, its pieces received into finished goods are given
 * codes, and the labels are printed. Scanning a piece shows what it is and
 * where it came from. Nothing here moves stock.
 */

const router = Router()
const MODULE = 'inventory'

const generateSchema = z.object({
  itemId: z.string().optional(),
  sizeId: z.string().nullable().optional(),
  grade: z.enum(['A', 'B']).optional(),
})
const printedSchema = z.object({ ids: z.array(z.string()).min(1).max(20_000) })
const voidSchema = z.object({ reason: z.string().trim().min(3, 'Say why the tag is being withdrawn') })

const EVENT_LABEL: Record<string, string> = {
  CUT: 'Cut',
  DISPATCH: 'Sent to',
  RECEIVE: 'Counted in',
  SHORT: 'Found short',
  EXCESS: 'Extra counted',
  SETTLE: 'Short settled',
  PROCESS: 'Worked / checked',
  DECIDE: 'Decision',
  REWORK_DONE: 'Rework done',
  VENDOR_RETURN: 'Back from the unit',
  PACK: 'Into finished goods',
  SPLIT: 'Bundle split',
  REVERSAL: 'Reversed',
}
const BUCKET_LABEL: Record<string, string> = {
  TRANSIT: 'on the way',
  WIP: 'in work',
  DONE: 'done',
  REWORK: 'for rework',
  DAMAGED: 'damaged',
  REJECTED: 'rejected',
  SHORT: 'short',
  B_GRADE: 'B-grade',
  SCRAPPED: 'scrapped',
  PACKED: 'packed',
  PACKED_B: 'packed B-grade',
}

/** Orders whose pieces can be tagged: switched on, or with pieces received into finished goods. */
router.get('/orders', requirePermission(MODULE, 'view'), async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  const orders = await prisma.manufacturingOrder.findMany({
    where: {
      OR: [{ tagGarments: true }, { fgReceipts: { some: { cancelledAt: null } } }],
      ...(q
        ? {
            AND: [
              {
                OR: [
                  { moNumber: { contains: q, mode: 'insensitive' } },
                  { so: { soNumber: { contains: q, mode: 'insensitive' } } },
                  { so: { customer: { name: { contains: q, mode: 'insensitive' } } } },
                  { lines: { some: { style: { code: { contains: q, mode: 'insensitive' } } } } },
                ],
              },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      moNumber: true,
      status: true,
      tagGarments: true,
      totalPlannedQty: true,
      so: { select: { soNumber: true, customerPORef: true, customer: { select: { name: true } } } },
      lines: { select: { color: true, style: { select: { code: true, name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  const ids = orders.map((o) => o.id)
  const [received, tagged, printed] = await Promise.all([
    prisma.finishedGoodsReceiptLine.findMany({
      where: { receipt: { moId: { in: ids }, cancelledAt: null } },
      select: { qty: true, receipt: { select: { moId: true } } },
    }),
    prisma.garment.groupBy({ by: ['moId'], where: { moId: { in: ids }, status: { not: 'VOID' } }, _count: true }),
    prisma.garment.groupBy({ by: ['moId'], where: { moId: { in: ids }, status: { not: 'VOID' }, printCount: { gt: 0 } }, _count: true }),
  ])
  const recOf = new Map<string, number>()
  for (const r of received) if (r.receipt.moId) recOf.set(r.receipt.moId, (recOf.get(r.receipt.moId) ?? 0) + Math.round(Number(r.qty)))
  const tagOf = new Map(tagged.map((t) => [t.moId, t._count]))
  const printOf = new Map(printed.map((t) => [t.moId, t._count]))
  res.json({
    success: true,
    data: orders.map((o) => ({
      id: o.id,
      moNumber: o.moNumber,
      status: o.status,
      tagGarments: o.tagGarments,
      planned: o.totalPlannedQty,
      soNumber: o.so?.soNumber ?? null,
      customerPORef: o.so?.customerPORef ?? null,
      customer: o.so?.customer?.name ?? null,
      styles: [...new Set(o.lines.map((l) => `${l.style.code} · ${l.color}`))],
      received: recOf.get(o.id) ?? 0,
      tagged: tagOf.get(o.id) ?? 0,
      printed: printOf.get(o.id) ?? 0,
    })),
  })
})

/** One order: received, tagged and printed by item, size and grade. */
router.get('/orders/:moId', requirePermission(MODULE, 'view'), async (req, res) => {
  const mo = await prisma.manufacturingOrder.findUnique({
    where: { id: req.params.moId },
    select: {
      id: true,
      moNumber: true,
      status: true,
      tagGarments: true,
      brand: { select: { name: true } },
      so: { select: { soNumber: true, customerPORef: true, customer: { select: { name: true } } } },
      fgReceipts: {
        select: {
          id: true,
          fgrNumber: true,
          receiptDate: true,
          cancelledAt: true,
          warehouse: { select: { name: true } },
          lines: {
            select: {
              id: true,
              qty: true,
              grade: true,
              item: { select: { id: true, code: true, name: true, color: true, style: { select: { code: true } } } },
              size: { select: { id: true, code: true, sequence: true } },
            },
          },
        },
        orderBy: { receiptDate: 'asc' },
      },
    },
  })
  if (!mo) throw new AppError('That manufacturing order does not exist', 404, 'NOT_FOUND')
  const counts = await prisma.garment.groupBy({
    by: ['fgReceiptLineId', 'status'],
    where: { moId: mo.id },
    _count: true,
  })
  const printed = await prisma.garment.groupBy({
    by: ['fgReceiptLineId'],
    where: { moId: mo.id, status: { not: 'VOID' }, printCount: { gt: 0 } },
    _count: true,
  })
  const printedOf = new Map(printed.map((p) => [p.fgReceiptLineId, p._count]))

  type Row = {
    key: string
    itemId: string
    itemCode: string
    item: string
    style: string
    color: string
    sizeId: string | null
    size: string
    sizeSeq: number
    grade: string
    received: number
    tagged: number
    printed: number
    inStock: number
  }
  const byKey = new Map<string, Row>()
  for (const r of mo.fgReceipts) {
    if (r.cancelledAt) continue
    for (const l of r.lines) {
      const key = `${l.item.id}|${l.size?.id ?? ''}|${l.grade}`
      const row =
        byKey.get(key) ??
        ({
          key,
          itemId: l.item.id,
          itemCode: l.item.code,
          item: l.item.name,
          style: l.item.style?.code ?? '',
          color: l.item.color ?? '',
          sizeId: l.size?.id ?? null,
          size: l.size?.code ?? '—',
          sizeSeq: l.size?.sequence ?? 0,
          grade: l.grade,
          received: 0,
          tagged: 0,
          printed: 0,
          inStock: 0,
        } as Row)
      row.received += Math.round(Number(l.qty))
      for (const c of counts.filter((c) => c.fgReceiptLineId === l.id)) {
        if (c.status !== 'VOID') row.tagged += c._count
        if (c.status === 'IN_STOCK') row.inStock += c._count
      }
      row.printed += printedOf.get(l.id) ?? 0
      byKey.set(key, row)
    }
  }
  const rows = [...byKey.values()].sort((a, b) => a.item.localeCompare(b.item) || a.sizeSeq - b.sizeSeq || a.grade.localeCompare(b.grade))
  res.json({
    success: true,
    data: {
      id: mo.id,
      moNumber: mo.moNumber,
      status: mo.status,
      tagGarments: mo.tagGarments,
      brand: mo.brand?.name ?? null,
      soNumber: mo.so?.soNumber ?? null,
      customerPORef: mo.so?.customerPORef ?? null,
      customer: mo.so?.customer?.name ?? null,
      receipts: mo.fgReceipts.map((r) => ({
        id: r.id,
        fgrNumber: r.fgrNumber,
        receiptDate: r.receiptDate,
        store: r.warehouse.name,
        cancelled: Boolean(r.cancelledAt),
        pieces: r.lines.reduce((s, l) => s + Math.round(Number(l.qty)), 0),
      })),
      rows,
      totals: rows.reduce(
        (t, r) => ({ received: t.received + r.received, tagged: t.tagged + r.tagged, printed: t.printed + r.printed, inStock: t.inStock + r.inStock }),
        { received: 0, tagged: 0, printed: 0, inStock: 0 },
      ),
    },
  })
})

/** Switching an order's garment tags on or off. Off only while nothing of it is tagged. */
router.patch('/orders/:moId', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { tagGarments } = z.object({ tagGarments: z.boolean() }).parse(req.body)
  const mo = await prisma.manufacturingOrder.findUnique({ where: { id: req.params.moId }, select: { id: true, moNumber: true, tagGarments: true } })
  if (!mo) throw new AppError('That manufacturing order does not exist', 404, 'NOT_FOUND')
  if (!tagGarments) {
    const n = await prisma.garment.count({ where: { moId: mo.id, status: { not: 'VOID' } } })
    if (n) throw new AppError(`${n} pieces of ${mo.moNumber} are already tagged, so its tags cannot be switched off.`, 409, 'ALREADY_TAGGED')
  }
  await prisma.manufacturingOrder.update({ where: { id: mo.id }, data: { tagGarments } })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: mo.id, before: { tagGarments: mo.tagGarments }, after: { tagGarments } })
  res.json({ success: true, message: tagGarments ? `${mo.moNumber}: every finished piece will get its own QR tag.` : `${mo.moNumber}: garment tags switched off.` })
})

/** Giving every received, untagged piece of an order its code — or of one item, size or grade. */
router.post('/orders/:moId/generate', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const filter = generateSchema.parse(req.body ?? {})
  const result = await prisma.$transaction((tx) => generateGarments(tx, req.params.moId, filter, req.user?.id ?? null), {
    timeout: 120_000,
    maxWait: 20_000,
  })
  if (!result.created) {
    res.json({ success: true, message: 'Every piece received is already tagged.', data: result })
    return
  }
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'Garment', entityId: req.params.moId, after: result })
  res.status(201).json({
    success: true,
    message: `${result.created} garment ${result.created === 1 ? 'tag' : 'tags'} made: ${result.first}${result.created > 1 ? ` to ${result.last}` : ''}.`,
    data: result,
  })
})

/** The pieces themselves, for the order's list and for choosing what to print. */
router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const where = labelWhere(req.query)
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200))
  const [total, rows] = await Promise.all([
    prisma.garment.count({ where }),
    prisma.garment.findMany({
      where,
      select: { id: true, code: true, grade: true, status: true, printCount: true, lastPrintedAt: true, bundleId: true, size: { select: { code: true } }, item: { select: { name: true } }, bundle: { select: { code: true } }, warehouse: { select: { name: true } } },
      orderBy: { code: 'asc' },
      take: limit,
    }),
  ])
  res.json({ success: true, data: rows, total })
})

/** Which garments a print or a list means, from the query string. */
function labelWhere(query: Record<string, unknown>): Prisma.GarmentWhereInput {
  const str = (k: string) => (typeof query[k] === 'string' ? (query[k] as string).trim() : '')
  // Track & Trace's list, printed exactly as it is filtered there.
  if (str('trace') === '1') {
    const opt = (k: string) => str(k) || undefined
    const status = ['IN_STOCK', 'PACKED', 'DISPATCHED', 'SCRAPPED'].includes(str('status')) ? str('status') : undefined
    const { where } = piecesWhere({ q: opt('q'), customerId: opt('customerId'), soId: opt('soId'), moId: opt('moId'), styleId: opt('styleId'), color: opt('color'), sizeId: opt('sizeId'), status, from: opt('from'), to: opt('to') })
    return str('only') === 'new' ? { AND: [where, { printCount: 0 }] } : where
  }
  const ids = str('ids') ? str('ids').split(',').filter(Boolean) : []
  // A job card's pieces: those sewn in its bundles.
  const bundles = str('bundles') ? str('bundles').split(',').filter(Boolean) : []
  return {
    status: { not: 'VOID' },
    ...(ids.length ? { id: { in: ids } } : {}),
    ...(bundles.length ? { bundleId: { in: bundles } } : {}),
    ...(str('moId') ? { moId: str('moId') } : {}),
    ...(str('itemId') ? { itemId: str('itemId') } : {}),
    ...(query.sizeId !== undefined && str('sizeId') !== 'all' ? { sizeId: str('sizeId') || null } : {}),
    ...(str('grade') ? { grade: str('grade') } : {}),
    ...(str('only') === 'new' ? { printCount: 0 } : {}),
    ...(str('q') ? { code: { contains: normaliseGarmentCode(str('q')).replace(/^G-0*/, ''), mode: 'insensitive' as const } } : {}),
  }
}

/** For printing: every label the query names, with what goes on it. */
router.get('/labels', requirePermission(MODULE, 'view'), async (req, res) => {
  const where = labelWhere(req.query)
  if (!req.query.ids && !req.query.moId && req.query.trace !== '1') throw new AppError('Choose the order or the pieces to print', 400, 'NO_FILTER')
  const retail = req.query.retail === '1'
  const [company, rows] = await Promise.all([
    prisma.company.findFirst({
      select: { name: true, legalName: true, address: true, city: true, state: true, pincode: true, phone: true, email: true, customerCare: true, countryOfOrigin: true, logoUrl: true },
    }),
    prisma.garment.findMany({
      where,
      take: 20_000,
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        grade: true,
        printCount: true,
        itemId: true,
        sizeId: true,
        item: {
          select: {
            code: true,
            name: true,
            color: true,
            style: { select: { code: true, name: true, mrp: true, composition: true, fabricType: true, washCare: true } },
          },
        },
        size: { select: { code: true } },
        fgReceipt: { select: { receiptDate: true } },
        mo: {
          select: {
            moNumber: true,
            brand: { select: { name: true, logoUrl: true } },
            so: { select: { soNumber: true, customerPORef: true, customer: { select: { name: true } } } },
          },
        },
        bundle: { select: { code: true, cuttingOrder: { select: { lotNo: true } }, moLine: { select: { jobCard: { select: { lotNo: true } } } } } },
        // The delivery challan it is on or went out on, once it is scanned onto one.
        dc: { select: { dcNumber: true, status: true } },
      },
    }),
  ])
  // The retail label's barcode: each style-colour-size's own, given now if it
  // has none yet (from the GS1 prefix in Settings → Company).
  const barcodes = retail
    ? await prisma.$transaction((tx) => barcodesFor(tx, rows.map((g) => ({ itemId: g.itemId, sizeId: g.sizeId })), (req as AuthRequest).user?.id ?? null), { timeout: 60_000 })
    : new Map<string, { ean: string; mrp: number | null }>()
  const mfd = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
  res.json({
    success: true,
    data: {
      company: company?.name ?? '',
      // Who made and sells it, for the retail label's legal lines.
      maker: retail
        ? {
            name: company?.legalName || company?.name || '',
            address: [company?.address, company?.city, company?.state, company?.pincode].filter(Boolean).join(', '),
            care: company?.customerCare || [company?.phone, company?.email].filter(Boolean).join(' · '),
            origin: company?.countryOfOrigin || 'India',
          }
        : null,
      garments: rows.map((g) => ({
        ...(retail
          ? {
              retail: {
                logoUrl: g.mo.brand?.logoUrl ?? company?.logoUrl ?? null,
                ean: barcodes.get(skuKey(g.itemId, g.sizeId))?.ean ?? null,
                mrp: barcodes.get(skuKey(g.itemId, g.sizeId))?.mrp ?? (g.item.style?.mrp == null ? null : Number(g.item.style.mrp)),
                composition: g.item.style?.composition || g.item.style?.fabricType || null,
                washCare: g.item.style?.washCare ?? [],
                mfd: mfd(g.fgReceipt.receiptDate),
              },
            }
          : {}),
        id: g.id,
        code: g.code,
        brand: g.mo.brand?.name ?? company?.name ?? '',
        style: g.item.style?.code ?? '',
        description: g.item.style?.name ?? g.item.name,
        size: g.size?.code ?? '',
        color: g.item.color ?? '',
        grade: g.grade,
        sku: g.item.code,
        moNumber: g.mo.moNumber,
        soNumber: g.mo.so?.soNumber ?? null,
        poRef: g.mo.so?.customerPORef ?? null,
        buyer: g.mo.so?.customer?.name ?? null,
        lot: g.bundle?.cuttingOrder?.lotNo ?? g.bundle?.moLine?.jobCard?.lotNo ?? null,
        challan: g.dc && g.dc.status !== 'CANCELLED' ? g.dc.dcNumber : null,
        printed: g.printCount > 0,
      })),
    },
  })
})

/** Labels sent to the printer: counted, so a reprint is told apart from a first print. */
router.post('/printed', requirePermission(MODULE, 'view'), async (req, res) => {
  const { ids } = printedSchema.parse(req.body)
  const r = await prisma.garment.updateMany({ where: { id: { in: ids } }, data: { printCount: { increment: 1 }, lastPrintedAt: new Date() } })
  res.json({ success: true, data: { updated: r.count } })
})

/** A scanned piece: what it is, where it came from, and what has happened to it. */
router.get('/scan/:code', requirePermission(MODULE, 'view'), async (req, res) => {
  const code = normaliseGarmentCode(decodeURIComponent(req.params.code))
  const g = await prisma.garment.findUnique({ where: { code }, select: { id: true } })
  if (!g) throw new AppError(`No garment with the code ${code}. Check the label, or type the number under the QR.`, 404, 'NOT_FOUND')
  res.json({ success: true, data: await garmentDetail(g.id) })
})

// ── Moving garments by scanning ────────────────────────────────────────────

const codesSchema = z.array(z.string().trim().min(1)).min(1, 'Scan at least one garment').max(2000, 'Up to 2,000 pieces at a time')
const OPEN = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] as const

/**
 * Whether a scanned piece can go on the action chosen, before it is added to
 * the list — so a piece already sent, held or written off is refused on the
 * spot, with where it is, rather than at the end.
 */
router.get('/check/:code', requirePermission(MODULE, 'view'), async (req, res) => {
  const code = normaliseGarmentCode(decodeURIComponent(req.params.code))
  const action = String(req.query.for ?? '')
  const g = await prisma.garment.findUnique({
    where: { code },
    select: {
      id: true,
      code: true,
      status: true,
      grade: true,
      soId: true,
      dcId: true,
      adjustmentId: true,
      warehouseId: true,
      item: { select: { name: true, color: true, style: { select: { code: true } } } },
      size: { select: { code: true } },
      warehouse: { select: { name: true } },
      dc: { select: { dcNumber: true, dispatchedAt: true, invoices: { where: { status: { not: 'CANCELLED' } }, select: { invoiceNumber: true } } } },
    },
  })
  if (!g) throw new AppError(`No garment with the code ${code}.`, 404, 'NOT_FOUND')
  const what = `${g.item.style?.code ?? g.item.name} ${g.item.color ?? ''} size ${g.size?.code ?? '—'}`.replace(/\s+/g, ' ')
  let problem: string | null = null
  if (action === 'return') {
    if (g.status !== 'DISPATCHED') problem = `${g.code} was never despatched, so it cannot come back.`
  } else if (g.status === 'DISPATCHED') {
    problem = `${g.code} was despatched on ${g.dc?.dcNumber ?? 'a challan'}${g.dc?.dispatchedAt ? ` on ${g.dc.dispatchedAt.toLocaleDateString('en-IN')}` : ''}. It cannot go out twice.`
  } else if (g.status === 'SCRAPPED') problem = `${g.code} was written off.`
  else if (g.status === 'VOID') problem = `${g.code}'s tag was withdrawn.`
  else if (g.adjustmentId) problem = `${g.code} is waiting for a write-off to be approved.`
  else if (g.dcId && action !== 'dispatch') problem = `${g.code} is on ${g.dc?.dcNumber}; take it off the challan first.`
  else if (g.grade === 'B' && (action === 'move' || action === 'scrap')) {
    problem = `${g.code} is B-grade; B-grade pieces cannot be ${action === 'move' ? 'moved between stores' : 'written off'} by scan yet.`
  }
  res.json({
    success: true,
    data: {
      id: g.id,
      code: g.code,
      what,
      grade: g.grade,
      store: g.warehouse.name,
      warehouseId: g.warehouseId,
      soId: g.soId,
      dcNumber: g.dc?.dcNumber ?? null,
      invoice: g.dc?.invoices[0]?.invoiceNumber ?? null,
      problem,
    },
  })
})

/** Open orders with tagged pieces to send, and the challans already being loaded for them. */
router.get('/dispatch/orders', requirePermission('sales', 'view'), async (_req, res) => {
  const free = await prisma.garment.groupBy({
    by: ['soId'],
    where: { status: 'IN_STOCK', dcId: null, adjustmentId: null, soId: { not: null } },
    _count: true,
  })
  const drafts = await prisma.deliveryChallan.findMany({
    where: { status: 'DRAFT', garments: { some: {} } },
    select: { id: true, dcNumber: true, soId: true, dcDate: true, warehouse: { select: { name: true } }, _count: { select: { garments: true } } },
  })
  const soIds = [...new Set([...free.map((f) => f.soId as string), ...drafts.map((d) => d.soId)])]
  const orders = await prisma.salesOrder.findMany({
    where: { id: { in: soIds }, status: { in: [...OPEN] } },
    select: { id: true, soNumber: true, customerPORef: true, customer: { select: { name: true } } },
    orderBy: { soNumber: 'desc' },
  })
  res.json({
    success: true,
    data: orders.map((o) => ({
      soId: o.id,
      soNumber: o.soNumber,
      poRef: o.customerPORef,
      customer: o.customer?.name ?? '',
      ready: free.find((f) => f.soId === o.id)?._count ?? 0,
      drafts: drafts
        .filter((d) => d.soId === o.id)
        .map((d) => ({ dcId: d.id, dcNumber: d.dcNumber, store: d.warehouse?.name ?? '', pieces: d._count.garments })),
    })),
  })
})

/** A challan being loaded: the pieces scanned onto it, by size. */
router.get('/dispatch/:dcId', requirePermission('sales', 'view'), async (req, res) => {
  res.json({ success: true, data: await loading(req.params.dcId) })
})

async function loading(dcId: string) {
  const dc = await prisma.deliveryChallan.findUnique({
    where: { id: dcId },
    select: {
      id: true,
      dcNumber: true,
      status: true,
      soId: true,
      so: { select: { soNumber: true, customer: { select: { name: true } } } },
      warehouse: { select: { name: true } },
    },
  })
  if (!dc) throw new AppError('That challan does not exist.', 404, 'NOT_FOUND')
  const pieces = await prisma.garment.findMany({
    where: { dcId },
    select: {
      id: true,
      code: true,
      grade: true,
      item: { select: { name: true, color: true, style: { select: { code: true } } } },
      size: { select: { code: true, sequence: true } },
    },
    orderBy: { updatedAt: 'desc' },
  })
  const bySize = new Map<string, { what: string; size: string; seq: number; grade: string; n: number }>()
  for (const p of pieces) {
    const what = `${p.item.style?.code ?? p.item.name} ${p.item.color ?? ''}`.trim()
    const key = `${what}|${p.size?.code ?? ''}|${p.grade}`
    const e = bySize.get(key) ?? { what, size: p.size?.code ?? '—', seq: p.size?.sequence ?? 0, grade: p.grade, n: 0 }
    e.n += 1
    bySize.set(key, e)
  }
  return {
    dcId: dc.id,
    dcNumber: dc.dcNumber,
    status: dc.status,
    soId: dc.soId,
    soNumber: dc.so.soNumber,
    customer: dc.so.customer?.name ?? '',
    store: dc.warehouse?.name ?? '',
    pieces: pieces.map((p) => ({ id: p.id, code: p.code, grade: p.grade, size: p.size?.code ?? '', what: `${p.item.style?.code ?? p.item.name} ${p.item.color ?? ''}`.trim() })),
    bySize: [...bySize.values()].sort((a, b) => a.what.localeCompare(b.what) || a.seq - b.seq),
  }
}

/** A scanned piece put on the order's challan; the first starts a draft. */
router.post('/dispatch/scan', requirePermission('sales', 'create'), async (req: AuthRequest, res) => {
  const data = z
    .object({ soId: z.string().min(1, 'Pick the order'), dcId: z.string().nullable().optional(), code: z.string().trim().min(1) })
    .parse(req.body)
  const r = await prisma.$transaction((tx) => addToChallan(tx, data, req.user!.id), { timeout: 60_000, maxWait: 20_000 })
  res.json({ success: true, message: `${r.piece.code} on the challan.`, data: await loading(r.dcId) })
})

/** A piece taken back off a challan still being loaded. */
router.delete('/dispatch/:dcId/pieces/:garmentId', requirePermission('sales', 'create'), async (req: AuthRequest, res) => {
  const r = await prisma.$transaction((tx) => removeFromChallan(tx, req.params.dcId, req.params.garmentId, req.user!.id), {
    timeout: 60_000,
    maxWait: 20_000,
  })
  res.json({
    success: true,
    message: r.emptied ? `${r.dcNumber} had nothing left on it and was cancelled.` : 'Taken off the challan.',
    data: r.emptied ? null : await loading(req.params.dcId),
  })
})

/** Dispatching the loaded challan: stock drops by exactly the pieces scanned. */
router.post('/dispatch/:dcId/dispatch', requirePermission('sales', 'create'), async (req: AuthRequest, res) => {
  const header = z
    .object({
      vehicleNumber: z.string().max(30).nullable().optional(),
      transporter: z.string().max(120).nullable().optional(),
      lrNumber: z.string().max(60).nullable().optional(),
      cartons: z.number().int().min(0).nullable().optional(),
    })
    .parse(req.body ?? {})
  const r = await prisma.$transaction((tx) => dispatchScanned(tx, req.params.dcId, header, req.user!.id), { timeout: 120_000, maxWait: 20_000 })
  await writeAuditLog(req, { module: 'sales', action: 'UPDATE', entityType: 'DeliveryChallan', entityId: req.params.dcId, after: { dispatchedByScan: r.pieces } })
  res.json({ success: true, message: `${r.dcNumber} dispatched: ${r.pieces} ${r.pieces === 1 ? 'piece' : 'pieces'} out of stock.`, data: r })
})

/** Scanned pieces moved to another store on one transfer note. */
router.post('/move', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = z.object({ codes: codesSchema, toWarehouseId: z.string().min(1, 'Pick the store they go to') }).parse(req.body)
  const r = await prisma.$transaction((tx) => moveGarments(tx, data, req.user!.id), { timeout: 120_000, maxWait: 20_000 })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'StockTransfer', entityId: r.transferNumber, after: { garments: data.codes.length } })
  res.json({ success: true, message: `${r.pieces} ${r.pieces === 1 ? 'piece' : 'pieces'} moved to ${r.to} on ${r.transferNumber}.`, data: r })
})

/** Despatched pieces back from a customer, on a return credit note. */
router.post('/return', requirePermission('sales', 'create'), async (req: AuthRequest, res) => {
  const data = z
    .object({
      codes: codesSchema,
      warehouseId: z.string().min(1, 'Pick the store they come back into'),
      reason: z.string().trim().min(3, 'Say why they came back'),
    })
    .parse(req.body)
  const r = await prisma.$transaction((tx) => returnGarments(tx, data, req.user!.id), { timeout: 120_000, maxWait: 20_000 })
  await writeAuditLog(req, { module: 'sales', action: 'CREATE', entityType: 'CreditNote', entityId: r.noteNumber, after: { garments: data.codes.length } })
  res.json({ success: true, message: `${r.pieces} ${r.pieces === 1 ? 'piece' : 'pieces'} back in stock on ${r.noteNumber} (against ${r.invoiceNumber}).`, data: r })
})

/** Damaged pieces put up for write-off, waiting for a store manager. */
router.post('/scrap', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = z.object({ codes: codesSchema, reason: z.string().trim().min(5, 'Say what is wrong with them') }).parse(req.body)
  const r = await prisma.$transaction((tx) => requestScrap(tx, data, req.user!.id), { timeout: 120_000, maxWait: 20_000 })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'StockAdjustment', entityId: r.adjustmentNumber, after: { garments: data.codes.length } })
  res.json({
    success: true,
    message: `${r.pieces} ${r.pieces === 1 ? 'piece' : 'pieces'} put up for write-off on ${r.adjustmentNumber}. Stock leaves when a store manager approves it; until then they are held.`,
    data: r,
  })
})

router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  res.json({ success: true, data: await garmentDetail(req.params.id) })
})

/** Withdrawing a tag made by mistake. The piece stays in stock, untagged, and can be tagged again. */
router.post('/:id/void', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = voidSchema.parse(req.body)
  const g = await prisma.garment.findUnique({ where: { id: req.params.id }, select: { id: true, code: true, status: true } })
  if (!g) throw new AppError('That garment does not exist', 404, 'NOT_FOUND')
  if (g.status !== 'IN_STOCK') throw new AppError(`${g.code} is ${g.status === 'VOID' ? 'already withdrawn' : 'packed or sent'}; only a tag in the store can be withdrawn.`, 400, 'NOT_IN_STOCK')
  await prisma.$transaction([
    prisma.garment.update({ where: { id: g.id }, data: { status: 'VOID' } }),
    prisma.garmentEvent.create({ data: { garmentId: g.id, type: 'VOIDED', notes: reason, createdById: (req as AuthRequest).user?.id ?? null } }),
  ])
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'Garment', entityId: g.id, before: { status: g.status }, after: { status: 'VOID', reason } })
  res.json({ success: true, message: `${g.code} withdrawn. Its piece is untagged and can be tagged again.`, data: await garmentDetail(g.id) })
})

export async function garmentDetail(id: string) {
  const g = await prisma.garment.findUnique({
    where: { id },
    include: {
      item: { select: { code: true, name: true, color: true, style: { select: { code: true, name: true } } } },
      size: { select: { code: true } },
      warehouse: { select: { name: true } },
      fgReceipt: { select: { id: true, fgrNumber: true, receiptDate: true, cancelledAt: true } },
      mo: { select: { id: true, moNumber: true, brand: { select: { name: true } }, so: { select: { soNumber: true, customerPORef: true, customer: { select: { name: true } } } } } },
      bundle: {
        select: {
          code: true,
          bundleNo: true,
          qty: true,
          cuttingOrder: { select: { cutOrderNumber: true, cutDate: true, lotNo: true } },
          moLine: { select: { jobCard: { select: { jobCardNumber: true, lotNo: true } } } },
        },
      },
      events: { orderBy: { createdAt: 'asc' }, include: { createdBy: { select: { name: true } } } },
    },
  })
  if (!g) throw new AppError('That garment does not exist', 404, 'NOT_FOUND')

  // The bundle's journey through the floor: every event that moved its pieces.
  const entries = g.bundleId
    ? await prisma.wipEntry.findMany({
        where: { bundleId: g.bundleId },
        select: {
          qty: true,
          bucket: true,
          step: { select: { name: true, sequence: true, isQcStep: true, kind: true } },
          event: {
            select: {
              id: true,
              type: true,
              eventDate: true,
              personName: true,
              reversedAt: true,
              vendor: { select: { name: true } },
              transfer: { select: { transferNumber: true } },
              fgReceipt: { select: { fgrNumber: true } },
              createdBy: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      })
    : []
  const byEvent = new Map<string, { date: Date; type: string; step: string; check: boolean; changes: string[]; ref: string | null; by: string | null; reversed: boolean }>()
  for (const e of entries) {
    const ev = byEvent.get(e.event.id) ?? {
      date: e.event.eventDate,
      type: EVENT_LABEL[e.event.type] ?? e.event.type,
      step: e.step.name,
      check: false,
      changes: [],
      ref: e.event.transfer?.transferNumber ?? e.event.fgReceipt?.fgrNumber ?? null,
      by: e.event.vendor?.name ?? e.event.personName ?? e.event.createdBy?.name ?? null,
      reversed: Boolean(e.event.reversedAt),
    }
    // What arrived somewhere, which is what a reader follows: "+20 done",
    // at the stage it arrived at — a send names where it went, not where it left.
    if (e.qty > 0) {
      ev.changes.push(`${e.qty} ${BUCKET_LABEL[e.bucket] ?? e.bucket.toLowerCase()}`)
      ev.step = e.step.name
      // A check's result, not every move through a check stage.
      ev.check = (e.step.isQcStep || e.step.kind === 'QC') && ['PROCESS', 'DECIDE', 'REWORK_DONE'].includes(e.event.type)
    }
    byEvent.set(e.event.id, ev)
  }

  return {
    id: g.id,
    code: g.code,
    status: g.status,
    grade: g.grade,
    ownership: g.ownership,
    printCount: g.printCount,
    lastPrintedAt: g.lastPrintedAt,
    createdAt: g.createdAt,
    style: g.item.style?.code ?? '',
    description: g.item.style?.name ?? g.item.name,
    item: g.item.name,
    sku: g.item.code,
    color: g.item.color ?? '',
    size: g.size?.code ?? '',
    store: g.warehouse.name,
    brand: g.mo.brand?.name ?? null,
    mo: { id: g.mo.id, moNumber: g.mo.moNumber },
    soNumber: g.mo.so?.soNumber ?? null,
    poRef: g.mo.so?.customerPORef ?? null,
    buyer: g.mo.so?.customer?.name ?? null,
    receipt: g.fgReceipt,
    bundle: g.bundle
      ? {
          code: g.bundle.code,
          bundleNo: g.bundle.bundleNo,
          qty: g.bundle.qty,
          cutOrder: g.bundle.cuttingOrder?.cutOrderNumber ?? null,
          cutDate: g.bundle.cuttingOrder?.cutDate ?? null,
          lot: g.bundle.cuttingOrder?.lotNo ?? g.bundle.moLine?.jobCard?.lotNo ?? null,
          jobCard: g.bundle.moLine?.jobCard?.jobCardNumber ?? null,
        }
      : null,
    production: [...byEvent.values()].filter((e) => e.changes.length),
    events: g.events.map((e) => ({ type: e.type, notes: e.notes, referenceNumber: e.referenceNumber, by: e.createdBy?.name ?? null, at: e.createdAt })),
  }
}

export default router
