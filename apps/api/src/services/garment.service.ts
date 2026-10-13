import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/*
 * Individual finished garments, each with its own QR label.
 *
 * A garment is made from a finished-goods receipt: one per piece received, so
 * it only exists once the piece has passed the last check and become stock.
 * The stock ledger still counts pieces by item, size and grade; a garment says
 * which piece is which and where it came from. Nothing here moves stock.
 */

/** G-00001234: what the QR carries and what is printed under it. */
export async function nextGarmentCodes(tx: Prisma.TransactionClient, n: number): Promise<string[]> {
  if (n <= 0) return []
  const rows = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('ld_erp.garment_code_seq') AS n FROM generate_series(1, ${n}::int)`
  return rows.map((r) => `G-${String(Number(r.n)).padStart(8, '0')}`)
}

/** A scanned or typed garment code, tidied: "g 1234", a link, or the code itself. */
export function normaliseGarmentCode(raw: string): string {
  let s = raw.trim()
  if (s.includes('/')) s = s.split('/').filter(Boolean).pop() ?? s
  s = s.toUpperCase().replace(/\s+/g, '')
  const digits = s.match(/^G-?(\d{1,10})$/)
  return digits ? `G-${digits[1].padStart(8, '0')}` : s
}

export const isGarmentCode = (raw: string) => /^G-\d{8}$/.test(normaliseGarmentCode(raw))

/** Held for the rest of the transaction, so two people cannot tag the same pieces twice. */
export async function lockOrder(tx: Prisma.TransactionClient, moId: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.manufacturing_orders WHERE id = ${moId} FOR UPDATE`
}

const sameColour = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()

/**
 * Tags every piece of an order received into finished goods and not yet
 * tagged — or only one item, size or grade of it. Each piece is put back to
 * the cutting bundle it was packed from, oldest bundle first, so scanning it
 * shows its own bundle's journey through the floor.
 */
export async function generateGarments(
  tx: Prisma.TransactionClient,
  moId: string,
  filter: { itemId?: string; sizeId?: string | null; grade?: string },
  userId: string | null,
) {
  await lockOrder(tx, moId)
  const mo = await tx.manufacturingOrder.findUnique({
    where: { id: moId },
    select: { moNumber: true, tagGarments: true, lines: { select: { id: true, styleId: true, color: true } } },
  })
  if (!mo) throw new AppError('That manufacturing order does not exist', 404, 'NOT_FOUND')
  if (!mo.tagGarments) {
    throw new AppError(`${mo.moNumber} is not set for garment tags. Switch "Tag garments" on for it first.`, 400, 'NOT_TAGGED_ORDER')
  }

  const receipts = await tx.finishedGoodsReceipt.findMany({
    where: { moId, cancelledAt: null },
    select: {
      id: true,
      fgrNumber: true,
      warehouseId: true,
      soId: true,
      so: { select: { isJobWork: true, customerId: true } },
      lines: {
        where: {
          ...(filter.itemId ? { itemId: filter.itemId } : {}),
          ...(filter.sizeId !== undefined ? { sizeId: filter.sizeId } : {}),
          ...(filter.grade ? { grade: filter.grade } : {}),
        },
        select: { id: true, itemId: true, sizeId: true, grade: true, qty: true, item: { select: { styleId: true, color: true } } },
      },
    },
    orderBy: { receiptDate: 'asc' },
  })
  const lineIds = receipts.flatMap((r) => r.lines.map((l) => l.id))
  const tagged = await tx.garment.groupBy({
    by: ['fgReceiptLineId'],
    where: { fgReceiptLineId: { in: lineIds }, status: { not: 'VOID' } },
    _count: true,
  })
  const taggedOf = new Map(tagged.map((t) => [t.fgReceiptLineId, t._count]))

  // The bundles each receipt packed from, and how many of each are already tagged.
  const packed = await tx.wipEntry.findMany({
    where: {
      eventType: 'PACK',
      qty: { gt: 0 },
      bucket: { in: ['PACKED', 'PACKED_B'] },
      event: { fgReceiptId: { in: receipts.map((r) => r.id) }, reversedAt: null },
    },
    select: { bundleId: true, moLineId: true, sizeId: true, bucket: true, qty: true, bundle: { select: { bundleNo: true } }, event: { select: { fgReceiptId: true } } },
  })
  const usedRows = await tx.garment.groupBy({
    by: ['fgReceiptId', 'bundleId', 'sizeId', 'grade'],
    where: { fgReceiptId: { in: receipts.map((r) => r.id) }, status: { not: 'VOID' }, bundleId: { not: null } },
    _count: true,
  })
  const used = new Map(usedRows.map((u) => [`${u.fgReceiptId}|${u.bundleId}|${u.sizeId ?? ''}|${u.grade}`, u._count]))
  const moLineOf = new Map(mo.lines.map((l) => [l.id, l]))

  const toCreate: Array<Prisma.GarmentCreateManyInput> = []
  for (const r of receipts) {
    const ownership = r.so?.isJobWork ? ('CUSTOMER_OWNED' as const) : ('OWNED' as const)
    for (const l of r.lines) {
      const left = Math.round(Number(l.qty)) - (taggedOf.get(l.id) ?? 0)
      if (left <= 0) continue
      // Bundles of this item, size and grade that this receipt packed.
      const pool = packed
        .filter((p) => {
          const ml = moLineOf.get(p.moLineId)
          return (
            p.event.fgReceiptId === r.id &&
            (p.sizeId ?? null) === (l.sizeId ?? null) &&
            p.bucket === (l.grade === 'B' ? 'PACKED_B' : 'PACKED') &&
            (!ml || (ml.styleId === l.item.styleId && sameColour(ml.color, l.item.color)))
          )
        })
        .sort((a, b) => a.bundle.bundleNo - b.bundle.bundleNo)
        .map((p) => {
          const key = `${r.id}|${p.bundleId}|${l.sizeId ?? ''}|${l.grade}`
          return { key, bundleId: p.bundleId, moLineId: p.moLineId, qty: p.qty }
        })
      let need = left
      for (const b of pool) {
        const free = Math.max(0, b.qty - (used.get(b.key) ?? 0))
        const take = Math.min(need, free)
        for (let i = 0; i < take; i++) toCreate.push(row(r, l, ownership, b.bundleId, b.moLineId))
        used.set(b.key, (used.get(b.key) ?? 0) + take)
        need -= take
        if (!need) break
      }
      // Received without a route (or more than the floor recorded): no bundle to point at.
      for (let i = 0; i < need; i++) toCreate.push(row(r, l, ownership, null, null))
    }
  }
  if (!toCreate.length) return { created: 0, first: null as string | null, last: null as string | null }
  if (toCreate.length > 20_000) throw new AppError('More than 20,000 pieces at once. Tag one size or item at a time.', 400, 'TOO_MANY')

  const codes = await nextGarmentCodes(tx, toCreate.length)
  toCreate.forEach((g, i) => (g.code = codes[i]))
  const made = await tx.garment.createManyAndReturn({ data: toCreate, select: { id: true } })
  await tx.garmentEvent.createMany({
    data: made.map((g) => ({ garmentId: g.id, type: 'TAGGED' as const, createdById: userId })),
  })
  return { created: made.length, first: codes[0], last: codes[codes.length - 1] }

  function row(
    r: (typeof receipts)[number],
    l: (typeof receipts)[number]['lines'][number],
    ownership: 'OWNED' | 'CUSTOMER_OWNED',
    bundleId: string | null,
    moLineId: string | null,
  ): Prisma.GarmentCreateManyInput {
    return {
      code: '',
      moId,
      moLineId,
      bundleId,
      fgReceiptId: r.id,
      fgReceiptLineId: l.id,
      itemId: l.itemId,
      sizeId: l.sizeId,
      grade: l.grade,
      warehouseId: r.warehouseId,
      ownership,
      ownerCustomerId: ownership === 'CUSTOMER_OWNED' ? (r.so?.customerId ?? null) : null,
      soId: r.soId,
      createdById: userId,
    }
  }
}

/**
 * A receipt cancelled takes its pieces out of stock, so their tags go too.
 * Pieces already packed or sent cannot be un-received: the stock service has
 * refused the cancel by then, but this says why if it is ever reached.
 */
export async function voidForCancelledReceipt(tx: Prisma.TransactionClient, receiptId: string, reason: string, userId: string | null) {
  const moving = await tx.garment.count({ where: { fgReceiptId: receiptId, status: { in: ['PACKED', 'DISPATCHED'] } } })
  if (moving) throw new AppError(`${moving} tagged pieces of this receipt are packed or sent, so it cannot be cancelled.`, 409, 'GARMENTS_MOVED')
  const live = await tx.garment.findMany({ where: { fgReceiptId: receiptId, status: 'IN_STOCK' }, select: { id: true } })
  if (!live.length) return 0
  await tx.garment.updateMany({ where: { id: { in: live.map((g) => g.id) } }, data: { status: 'VOID' } })
  await tx.garmentEvent.createMany({
    data: live.map((g) => ({ garmentId: g.id, type: 'VOIDED' as const, notes: reason, referenceType: 'FG_RECEIPT_CANCEL', referenceId: receiptId, createdById: userId })),
  })
  return live.length
}
