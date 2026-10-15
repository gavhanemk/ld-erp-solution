import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { balanceOf } from './stock.service'
import { normaliseGarmentCode } from './garment.service'
import { dispatchChallan, loadOpenOrder, writeChallan } from '../routes/challan.routes'
import { createAdjustment, createTransfer } from '../routes/inventory.routes'
import { createCreditNote } from '../routes/creditNote.routes'
import { event } from './garmentHooks.service'

/*
 * Garments moved by scanning: onto a challan and out, to another store, back
 * from a customer, written off.
 *
 * Every move goes through the document the store already uses — a delivery
 * challan, a stock transfer, a credit note, a stock adjustment — so stock
 * leaves and arrives exactly as it does without a scanner. A scan alone moves
 * nothing; the confirm does. A piece already sent, held on another challan
 * or waiting on a write-off is refused, named, with where it is.
 */

const garmentSelect = {
  id: true,
  code: true,
  status: true,
  grade: true,
  itemId: true,
  sizeId: true,
  warehouseId: true,
  ownership: true,
  ownerCustomerId: true,
  soId: true,
  dcId: true,
  adjustmentId: true,
  item: { select: { name: true, color: true, style: { select: { code: true } } } },
  size: { select: { code: true } },
  warehouse: { select: { name: true } },
  dc: { select: { dcNumber: true, status: true, dispatchedAt: true } },
} satisfies Prisma.GarmentSelect

type Piece = Prisma.GarmentGetPayload<{ select: typeof garmentSelect }>

const label = (g: Piece) => `${g.code} (${g.item.style?.code ?? g.item.name} ${g.item.color ?? ''} size ${g.size?.code ?? '—'})`.replace(/\s+/g, ' ')
const day = (d: Date | null | undefined) => (d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '')

/** The pieces named, locked for the transaction; refused if any is unknown. */
async function lockPieces(tx: Prisma.TransactionClient, codes: string[]): Promise<Piece[]> {
  const wanted = [...new Set(codes.map(normaliseGarmentCode))]
  if (!wanted.length) throw new AppError('Scan at least one garment.', 400, 'NOTHING_SCANNED')
  const ids = await tx.garment.findMany({ where: { code: { in: wanted } }, select: { id: true, code: true } })
  const missing = wanted.filter((c) => !ids.some((g) => g.code === c))
  if (missing.length) throw new AppError(`No garment with the code ${missing.join(', ')}.`, 404, 'NOT_FOUND')
  await tx.$queryRaw`SELECT id FROM ld_erp.garments WHERE id = ANY(${ids.map((g) => g.id)}::text[]) FOR UPDATE`
  return tx.garment.findMany({ where: { id: { in: ids.map((g) => g.id) } }, select: garmentSelect })
}

/** Why a piece cannot move now, or null when it can. */
function blocker(g: Piece, ownChallan?: string): string | null {
  if (g.status === 'DISPATCHED') return `${label(g)} was despatched on ${g.dc?.dcNumber ?? 'a challan'}${g.dc?.dispatchedAt ? ` on ${day(g.dc.dispatchedAt)}` : ''}.`
  if (g.status === 'SCRAPPED') return `${label(g)} was written off.`
  if (g.status === 'VOID') return `${g.code}'s tag was withdrawn.`
  if (g.adjustmentId) return `${label(g)} is waiting for a write-off to be approved.`
  if (g.dcId && g.dcId !== ownChallan) return `${label(g)} is already on ${g.dc?.dcNumber ?? 'another challan'}.`
  return null
}

/** What is left in the store after a move, for the confirmation: "size 38 now 29". */
async function availableNow(tx: Prisma.TransactionClient, pieces: Piece[], warehouseId: string) {
  const seen = new Map<string, Piece>()
  for (const g of pieces) seen.set(`${g.itemId}|${g.sizeId ?? ''}|${g.grade}|${g.ownership}|${g.ownerCustomerId ?? ''}`, g)
  const out = []
  for (const g of seen.values()) {
    const b = await balanceOf(tx, { itemId: g.itemId, warehouseId, sizeId: g.sizeId, grade: g.grade, ownership: g.ownership, ownerCustomerId: g.ownerCustomerId })
    out.push({ item: `${g.item.style?.code ?? g.item.name} ${g.item.color ?? ''}`.trim(), size: g.size?.code ?? '', grade: g.grade, qty: Math.round(b.qty) })
  }
  return out
}

// ── Despatch ────────────────────────────────────────────────────────────────

/**
 * Rewrites a draft challan's lines from the pieces scanned onto it, through
 * the challan's own checks: sizes on the order, nothing more than it wants.
 */
async function rebuildChallan(tx: Prisma.TransactionClient, dcId: string, userId: string) {
  const dc = await tx.deliveryChallan.findUniqueOrThrow({ where: { id: dcId } })
  const order = await loadOpenOrder(tx, dc.soId)
  const pieces = await tx.garment.findMany({ where: { dcId, status: 'IN_STOCK' }, select: { itemId: true, sizeId: true, grade: true } })
  const groups = new Map<string, { soLineId: string; grade: 'A' | 'B'; sizes: Map<string, number>; qty: number }>()
  for (const p of pieces) {
    const line = order.lines.find((l) => l.itemId === p.itemId)
    if (!line) throw new AppError(`That item is not on ${order.soNumber}.`, 400, 'NOT_ON_ORDER')
    const grade = p.grade === 'B' ? 'B' : 'A'
    const key = `${line.id}|${grade}`
    const g = groups.get(key) ?? { soLineId: line.id, grade, sizes: new Map(), qty: 0 }
    if (p.sizeId) g.sizes.set(p.sizeId, (g.sizes.get(p.sizeId) ?? 0) + 1)
    else g.qty += 1
    groups.set(key, g)
  }
  await writeChallan(
    tx,
    order,
    {
      soId: dc.soId,
      warehouseId: dc.warehouseId!,
      dcDate: dc.dcDate,
      deliveryAddress: dc.deliveryAddress,
      transporter: dc.transporter,
      vehicleNumber: dc.vehicleNumber,
      lrNumber: dc.lrNumber,
      eWayBillNumber: dc.eWayBillNumber,
      cartons: dc.cartons,
      packingNote: dc.packingNote,
      notes: dc.notes,
      lines: [...groups.values()].map((g) => ({
        soLineId: g.soLineId,
        grade: g.grade,
        ...(g.sizes.size ? { sizes: [...g.sizes].map(([sizeId, qty]) => ({ sizeId, qty })) } : { qty: g.qty }),
      })),
    },
    { id: dc.id },
    userId,
  )
}

/**
 * A scanned piece put on a challan. With no challan yet, the first piece
 * starts a draft for the order, from the store the piece is in. Each piece is
 * then held for this challan until it is dispatched or taken off.
 */
export async function addToChallan(
  tx: Prisma.TransactionClient,
  data: { soId: string; dcId?: string | null; code: string },
  userId: string,
) {
  const [g] = await lockPieces(tx, [data.code])
  let dcId = data.dcId ?? null
  if (dcId) {
    await tx.$queryRaw`SELECT id FROM ld_erp.delivery_challans WHERE id = ${dcId} FOR UPDATE`
    const dc = await tx.deliveryChallan.findUnique({ where: { id: dcId }, select: { status: true, dcNumber: true, soId: true, warehouseId: true } })
    if (!dc) throw new AppError('That challan does not exist.', 404, 'NOT_FOUND')
    if (dc.status !== 'DRAFT') throw new AppError(`${dc.dcNumber} is already ${dc.status.toLowerCase()}; start a new challan.`, 409, 'NOT_DRAFT')
    if (dc.soId !== data.soId) throw new AppError(`${dc.dcNumber} is for another order.`, 400, 'WRONG_ORDER')
    if (g.dcId === dcId) throw new AppError(`${label(g)} is already on ${dc.dcNumber}.`, 409, 'ALREADY_ON')
    if (dc.warehouseId !== g.warehouseId) throw new AppError(`${label(g)} is in ${g.warehouse.name}; ${dc.dcNumber} sends from another store.`, 400, 'WRONG_STORE')
  }
  const why = blocker(g)
  if (why) throw new AppError(why, 409, 'CANNOT_DISPATCH')
  if (g.soId && g.soId !== data.soId) {
    const so = await tx.salesOrder.findUnique({ where: { id: g.soId }, select: { soNumber: true } })
    throw new AppError(`${label(g)} was made for ${so?.soNumber ?? 'another order'}.`, 400, 'OTHER_ORDER')
  }

  if (!dcId) {
    const order = await loadOpenOrder(tx, data.soId)
    const line = order.lines.find((l) => l.itemId === g.itemId)
    if (!line) throw new AppError(`${label(g)} is not on ${order.soNumber}.`, 400, 'NOT_ON_ORDER')
    const created = await writeChallan(
      tx,
      order,
      {
        soId: data.soId,
        warehouseId: g.warehouseId,
        lines: [{ soLineId: line.id, grade: g.grade === 'B' ? 'B' : 'A', ...(g.sizeId ? { sizes: [{ sizeId: g.sizeId, qty: 1 }] } : { qty: 1 }) }],
      },
      null,
      userId,
    )
    dcId = created.id
  }
  await tx.garment.update({ where: { id: g.id }, data: { dcId } })
  await rebuildChallan(tx, dcId, userId)
  const dc = await tx.deliveryChallan.findUniqueOrThrow({ where: { id: dcId }, select: { dcNumber: true } })
  await event(tx, [g.id], 'ON_CHALLAN', { type: 'DELIVERY_CHALLAN', id: dcId, number: dc.dcNumber }, userId)
  return { dcId, piece: g }
}

/** A piece taken back off a draft challan. The last one off cancels the empty draft. */
export async function removeFromChallan(tx: Prisma.TransactionClient, dcId: string, garmentId: string, userId: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.delivery_challans WHERE id = ${dcId} FOR UPDATE`
  const dc = await tx.deliveryChallan.findUnique({ where: { id: dcId }, select: { status: true, dcNumber: true } })
  if (!dc) throw new AppError('That challan does not exist.', 404, 'NOT_FOUND')
  if (dc.status !== 'DRAFT') throw new AppError(`${dc.dcNumber} is already ${dc.status.toLowerCase()}.`, 409, 'NOT_DRAFT')
  const g = await tx.garment.findUnique({ where: { id: garmentId }, select: { id: true, dcId: true } })
  if (!g || g.dcId !== dcId) throw new AppError(`That piece is not on ${dc.dcNumber}.`, 400, 'NOT_ON')
  await tx.garment.update({ where: { id: g.id }, data: { dcId: null } })
  await event(tx, [g.id], 'OFF_CHALLAN', { type: 'DELIVERY_CHALLAN', id: dcId, number: dc.dcNumber }, userId)
  const left = await tx.garment.count({ where: { dcId } })
  if (left) {
    await rebuildChallan(tx, dcId, userId)
    return { emptied: false, dcNumber: dc.dcNumber }
  }
  // Nothing left to send: the draft goes, rather than sitting empty.
  await tx.deliveryChallanLine.deleteMany({ where: { dcId } })
  await tx.deliveryChallan.update({
    where: { id: dcId },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: userId, cancelReason: 'Every scanned piece was taken off' },
  })
  return { emptied: true, dcNumber: dc.dcNumber }
}

/**
 * Dispatching a scanned challan: refused unless its lines are exactly the
 * pieces scanned onto it, so stock drops by those pieces and nothing else.
 */
export async function dispatchScanned(
  tx: Prisma.TransactionClient,
  dcId: string,
  header: { vehicleNumber?: string | null; transporter?: string | null; lrNumber?: string | null; cartons?: number | null },
  userId: string,
) {
  await tx.$queryRaw`SELECT id FROM ld_erp.delivery_challans WHERE id = ${dcId} FOR UPDATE`
  const dc = await tx.deliveryChallan.findUnique({
    where: { id: dcId },
    select: { status: true, dcNumber: true, warehouseId: true, lines: { select: { qty: true } } },
  })
  if (!dc) throw new AppError('That challan does not exist.', 404, 'NOT_FOUND')
  if (dc.status !== 'DRAFT') throw new AppError(`${dc.dcNumber} is already ${dc.status.toLowerCase()}.`, 409, 'NOT_DRAFT')
  const pieces = await tx.garment.findMany({ where: { dcId, status: 'IN_STOCK' }, select: garmentSelect })
  const onLines = Math.round(dc.lines.reduce((s, l) => s + Number(l.qty), 0))
  if (!pieces.length) throw new AppError(`Nothing is scanned onto ${dc.dcNumber}.`, 400, 'NOTHING_SCANNED')
  if (onLines !== pieces.length) {
    throw new AppError(
      `${dc.dcNumber} lists ${onLines} pieces but ${pieces.length} are scanned onto it — it was changed on the Sales screen. Scan the rest, or dispatch it from there.`,
      409,
      'COUNT_MISMATCH',
    )
  }
  await tx.deliveryChallan.update({
    where: { id: dcId },
    data: {
      ...(header.vehicleNumber !== undefined ? { vehicleNumber: header.vehicleNumber?.toUpperCase() || null } : {}),
      ...(header.transporter !== undefined ? { transporter: header.transporter || null } : {}),
      ...(header.lrNumber !== undefined ? { lrNumber: header.lrNumber || null } : {}),
      ...(header.cartons !== undefined ? { cartons: header.cartons ?? null } : {}),
    },
  })
  // Dispatching marks the scanned pieces as gone (see garmentHooks).
  await dispatchChallan(tx, dcId, userId)
  return { dcNumber: dc.dcNumber, pieces: pieces.length, available: await availableNow(tx, pieces, dc.warehouseId!) }
}

// ── Between stores ──────────────────────────────────────────────────────────

/** Scanned pieces moved to another store on one stock transfer note. */
export async function moveGarments(tx: Prisma.TransactionClient, data: { codes: string[]; toWarehouseId: string }, userId: string) {
  const pieces = await lockPieces(tx, data.codes)
  for (const g of pieces) {
    const why = blocker(g)
    if (why) throw new AppError(why, 409, 'CANNOT_MOVE')
    if (g.dcId) throw new AppError(`${label(g)} is on ${g.dc?.dcNumber}; take it off the challan first.`, 409, 'ON_CHALLAN')
    // A stock transfer carries the size but not the grade.
    if (g.grade === 'B') throw new AppError(`${label(g)} is B-grade; B-grade pieces cannot be moved between stores yet.`, 400, 'B_GRADE')
  }
  const from = [...new Set(pieces.map((g) => g.warehouseId))]
  if (from.length > 1) throw new AppError('These pieces are in different stores. Move one store’s pieces at a time.', 400, 'MIXED_STORES')
  if (from[0] === data.toWarehouseId) throw new AppError(`These pieces are already in ${pieces[0].warehouse.name}.`, 400, 'SAME_STORE')

  const lines = new Map<string, { itemId: string; sizeId: string | null; ownership: 'OWNED' | 'CUSTOMER_OWNED'; ownerCustomerId: string | null; qty: number }>()
  for (const g of pieces) {
    const key = `${g.itemId}|${g.sizeId ?? ''}|${g.ownership}|${g.ownerCustomerId ?? ''}`
    const l = lines.get(key) ?? { itemId: g.itemId, sizeId: g.sizeId, ownership: g.ownership, ownerCustomerId: g.ownerCustomerId, qty: 0 }
    l.qty += 1
    lines.set(key, l)
  }
  const note = await createTransfer(
    tx,
    { fromWarehouseId: from[0], toWarehouseId: data.toWarehouseId, notes: `${pieces.length} tagged pieces, by scan`, lines: [...lines.values()] },
    userId,
    { stickers: 'caller' },
  )
  await tx.garment.updateMany({ where: { id: { in: pieces.map((g) => g.id) } }, data: { warehouseId: data.toWarehouseId } })
  await event(tx, pieces.map((g) => g.id), 'TRANSFERRED', { type: 'STOCK_TRANSFER', id: note.id, number: note.transferNumber, notes: `${note.fromWarehouse.name} → ${note.toWarehouse.name}` }, userId)
  return { transferNumber: note.transferNumber, to: note.toWarehouse.name, pieces: pieces.length, available: await availableNow(tx, pieces, data.toWarehouseId) }
}

// ── Back from a customer ────────────────────────────────────────────────────

/**
 * Despatched pieces scanned back in: a return credit note against their
 * invoice, with exactly these pieces on it, and the pieces back in stock.
 */
export async function returnGarments(tx: Prisma.TransactionClient, data: { codes: string[]; warehouseId: string; reason: string }, userId: string) {
  const pieces = await lockPieces(tx, data.codes)
  for (const g of pieces) {
    if (g.status !== 'DISPATCHED') throw new AppError(`${label(g)} was never despatched, so it cannot come back.`, 400, 'NOT_SENT')
  }
  const dcIds = [...new Set(pieces.map((g) => g.dcId).filter((x): x is string => Boolean(x)))]
  const invoices = await tx.salesInvoice.findMany({
    where: { dcId: { in: dcIds }, status: { not: 'CANCELLED' } },
    select: { id: true, invoiceNumber: true, dcId: true, lines: { select: { id: true, itemId: true, grade: true } } },
  })
  const notInvoiced = dcIds.filter((d) => !invoices.some((i) => i.dcId === d))
  if (notInvoiced.length) {
    const dcs = await tx.deliveryChallan.findMany({ where: { id: { in: notInvoiced } }, select: { dcNumber: true } })
    throw new AppError(
      `${dcs.map((d) => d.dcNumber).join(', ')} ${dcs.length === 1 ? 'is' : 'are'} not invoiced yet, so a credit note cannot be made. Cancel the challan to bring all its pieces back, or invoice it first.`,
      400,
      'NOT_INVOICED',
    )
  }
  if (invoices.length > 1) {
    throw new AppError(`These pieces were billed on ${invoices.map((i) => i.invoiceNumber).join(' and ')}. Return one invoice's pieces at a time.`, 400, 'MIXED_INVOICES')
  }
  const inv = invoices[0]
  const lines = new Map<string, { invoiceLineId: string; sizes: Map<string, number>; qty: number }>()
  for (const g of pieces) {
    const il = inv.lines.find((l) => l.itemId === g.itemId && l.grade === g.grade)
    if (!il) throw new AppError(`${label(g)} is not on ${inv.invoiceNumber}.`, 400, 'NOT_ON_INVOICE')
    const l = lines.get(il.id) ?? { invoiceLineId: il.id, sizes: new Map(), qty: 0 }
    if (g.sizeId) l.sizes.set(g.sizeId, (l.sizes.get(g.sizeId) ?? 0) + 1)
    else l.qty += 1
    lines.set(il.id, l)
  }
  const note = await createCreditNote(
    tx,
    {
      invoiceId: inv.id,
      type: 'RETURN',
      warehouseId: data.warehouseId,
      reason: data.reason,
      notes: `${pieces.length} tagged pieces, by scan: ${pieces.map((g) => g.code).join(', ')}`.slice(0, 1000),
      lines: [...lines.values()].map((l) => (l.sizes.size ? { invoiceLineId: l.invoiceLineId, sizes: [...l.sizes].map(([sizeId, qty]) => ({ sizeId, qty })) } : { invoiceLineId: l.invoiceLineId, qty: l.qty })),
    },
    userId,
  )
  const noteNumber = (note as { noteNumber?: string }).noteNumber ?? 'the credit note'
  await tx.garment.updateMany({
    where: { id: { in: pieces.map((g) => g.id) } },
    data: { status: 'IN_STOCK', dcId: null, warehouseId: data.warehouseId, creditNoteId: (note as { id: string }).id },
  })
  await event(tx, pieces.map((g) => g.id), 'RETURNED', { type: 'CREDIT_NOTE', id: (note as { id: string }).id, number: noteNumber, notes: data.reason }, userId)
  return { noteNumber, invoiceNumber: inv.invoiceNumber, pieces: pieces.length, available: await availableNow(tx, pieces, data.warehouseId) }
}

// ── Written off ─────────────────────────────────────────────────────────────

/**
 * Damaged pieces put up for write-off: a stock adjustment that waits for a
 * store manager. The pieces are held meanwhile; stock leaves on approval.
 */
export async function requestScrap(tx: Prisma.TransactionClient, data: { codes: string[]; reason: string }, userId: string) {
  const pieces = await lockPieces(tx, data.codes)
  for (const g of pieces) {
    const why = blocker(g)
    if (why) throw new AppError(why, 409, 'CANNOT_SCRAP')
    if (g.dcId) throw new AppError(`${label(g)} is on ${g.dc?.dcNumber}; take it off the challan first.`, 409, 'ON_CHALLAN')
    // A stock adjustment carries the size but not the grade.
    if (g.grade === 'B') throw new AppError(`${label(g)} is B-grade; B-grade pieces cannot be written off by scan yet.`, 400, 'B_GRADE')
  }
  const stores = [...new Set(pieces.map((g) => g.warehouseId))]
  if (stores.length > 1) throw new AppError('These pieces are in different stores. Write off one store’s pieces at a time.', 400, 'MIXED_STORES')

  const groups = new Map<string, { itemId: string; sizeId: string | null; ownership: 'OWNED' | 'CUSTOMER_OWNED'; ownerCustomerId: string | null; n: number }>()
  for (const g of pieces) {
    const key = `${g.itemId}|${g.sizeId ?? ''}|${g.ownership}|${g.ownerCustomerId ?? ''}`
    const x = groups.get(key) ?? { itemId: g.itemId, sizeId: g.sizeId, ownership: g.ownership, ownerCustomerId: g.ownerCustomerId, n: 0 }
    x.n += 1
    groups.set(key, x)
  }
  const lines = []
  for (const x of groups.values()) {
    const b = await balanceOf(tx, { itemId: x.itemId, warehouseId: stores[0], sizeId: x.sizeId, ownership: x.ownership, ownerCustomerId: x.ownerCustomerId })
    lines.push({ itemId: x.itemId, sizeId: x.sizeId, ownership: x.ownership, ownerCustomerId: x.ownerCustomerId, countedQty: Math.max(0, b.qty - x.n) })
  }
  const adj = (await createAdjustment(tx, { warehouseId: stores[0], reason: `Write-off by scan: ${data.reason}`, lines }, userId)) as { id: string; adjustmentNumber: string }
  await tx.garment.updateMany({ where: { id: { in: pieces.map((g) => g.id) } }, data: { adjustmentId: adj.id } })
  await event(tx, pieces.map((g) => g.id), 'SCRAP_REQUESTED', { type: 'STOCK_ADJUSTMENT', id: adj.id, number: adj.adjustmentNumber, notes: data.reason }, userId)
  return { adjustmentNumber: adj.adjustmentNumber, pieces: pieces.length }
}
