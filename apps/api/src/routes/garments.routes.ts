import { Router } from 'express'
import { z } from 'zod'
import { prisma, type Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { generateGarments, normaliseGarmentCode } from '../services/garment.service'

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
      select: { id: true, code: true, grade: true, status: true, printCount: true, lastPrintedAt: true, size: { select: { code: true } }, item: { select: { name: true } } },
      orderBy: { code: 'asc' },
      take: limit,
    }),
  ])
  res.json({ success: true, data: rows, total })
})

/** Which garments a print or a list means, from the query string. */
function labelWhere(query: Record<string, unknown>): Prisma.GarmentWhereInput {
  const str = (k: string) => (typeof query[k] === 'string' ? (query[k] as string).trim() : '')
  const ids = str('ids') ? str('ids').split(',').filter(Boolean) : []
  return {
    status: { not: 'VOID' },
    ...(ids.length ? { id: { in: ids } } : {}),
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
  if (!req.query.ids && !req.query.moId) throw new AppError('Choose the order or the pieces to print', 400, 'NO_FILTER')
  const [company, rows] = await Promise.all([
    prisma.company.findFirst({ select: { name: true } }),
    prisma.garment.findMany({
      where,
      take: 20_000,
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        grade: true,
        printCount: true,
        item: { select: { code: true, name: true, color: true, style: { select: { code: true, name: true } } } },
        size: { select: { code: true } },
        mo: { select: { moNumber: true, brand: { select: { name: true } }, so: { select: { soNumber: true, customerPORef: true, customer: { select: { name: true } } } } } },
        bundle: { select: { code: true, cuttingOrder: { select: { lotNo: true } }, moLine: { select: { jobCard: { select: { lotNo: true } } } } } },
      },
    }),
  ])
  res.json({
    success: true,
    data: {
      company: company?.name ?? '',
      garments: rows.map((g) => ({
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

async function garmentDetail(id: string) {
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
