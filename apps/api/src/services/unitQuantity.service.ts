import type { Prisma, PrismaClient } from '@prisma/client'
import { fitsPlaces, placesMessage, qtyPlaces, roundDownToPlaces, roundUpToPlaces } from '@ld-erp/shared'
import { AppError } from '../middleware/errorHandler'

type Db = PrismaClient | Prisma.TransactionClient

/** A quantity on its way into the books, with the item it counts. */
export interface QtyCheck {
  itemId: string
  qty: number | string | Prisma.Decimal | null | undefined
  /** What the quantity is, for the message: "Issue", "Received", "Rejected". */
  what?: string
}

/** Each item's places after the point (its own, else its unit's), read once. */
export async function placesOfItems(db: Db, itemIds: string[]): Promise<Map<string, { places: number; name: string; unit: string }>> {
  const ids = [...new Set(itemIds.filter(Boolean))]
  if (!ids.length) return new Map()
  const items = await db.item.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, decimalPlaces: true, uom: { select: { symbol: true, decimalPlaces: true } } },
  })
  return new Map(items.map((i) => [i.id, { places: qtyPlaces(i), name: i.name, unit: i.uom.symbol }]))
}

/**
 * Refuses a save when a quantity carries more places than its item allows: no
 * 2.5 cartons, whatever the screen sent. Empty quantities are left to each
 * route's own "required" rule; zero and negatives to its schema.
 */
export async function assertQtyFitsUnits(db: Db, lines: QtyCheck[]): Promise<void> {
  const present = lines.filter((l) => l.itemId && l.qty != null && String(l.qty).trim() !== '')
  if (!present.length) return
  const places = await placesOfItems(db, present.map((l) => l.itemId))
  for (const l of present) {
    const p = places.get(l.itemId)
    if (!p) continue // An unknown item is the route's own error to raise.
    const qty = Number(l.qty)
    if (!fitsPlaces(qty, p.places)) {
      throw new AppError(
        `${p.name}${l.what ? ` (${l.what.toLowerCase()})` : ''}: ${qty} ${p.unit}. ${placesMessage(p.places)}`,
        400,
        'QTY_NOT_IN_UNIT',
      )
    }
  }
}

/**
 * Before a requisition is approved, from any door (its own screen, the
 * approvals inbox, the assistant): one raised before its item's unit counted
 * whole (2.1 cartons) is not approved as it stands. A raised requisition is
 * not edited, so it is refused and raised again for what can be handed over.
 */
export async function assertRequisitionFitsUnits(db: Db, mrId: string): Promise<void> {
  const mr = await db.materialRequisition.findUnique({
    where: { id: mrId },
    select: { mrNumber: true, lines: { select: { itemId: true, requestedQty: true } } },
  })
  if (!mr) return
  try {
    await assertQtyFitsUnits(db, mr.lines.map((l) => ({ itemId: l.itemId, qty: l.requestedQty, what: 'Asked for' })))
  } catch (e) {
    if (!(e instanceof AppError)) throw e
    throw new AppError(`${e.message} Refuse ${mr.mrNumber} and raise it again for a whole number.`, 400, 'QTY_NOT_IN_UNIT')
  }
}

/** Lines another document points at, by what they are on. */
export type LineKind = 'poLine' | 'grnLine' | 'billLine' | 'mrLine' | 'customerGrnLine' | 'jobWorkLine' | 'enquiryLine' | 'package' | 'transferLine'

/**
 * The item behind each line a document points at — a receipt line names its
 * order line, a return names its bill line — so the same check can run on them.
 */
export async function itemsOfLines(
  db: Db,
  kind: LineKind,
  ids: string[],
): Promise<Map<string, string>> {
  const where = { where: { id: { in: [...new Set(ids.filter(Boolean))] } }, select: { id: true, itemId: true } }
  const rows: Array<{ id: string; itemId: string | null }> =
    kind === 'poLine'
      ? await db.purchaseOrderLine.findMany(where)
      : kind === 'grnLine'
        ? await db.gRNLine.findMany(where)
        : kind === 'billLine'
          ? await db.purchaseInvoiceLine.findMany(where)
          : kind === 'mrLine'
            ? await db.materialRequisitionLine.findMany(where)
            : kind === 'customerGrnLine'
              ? await db.customerGRNLine.findMany(where)
              : kind === 'enquiryLine'
                ? await db.purchaseEnquiryLine.findMany(where)
                : kind === 'package'
                  ? await db.stockPackage.findMany(where)
                  : kind === 'transferLine'
                    ? await db.stockTransferLine.findMany(where)
                    : await db.jobWorkChallanLine.findMany(where)
  return new Map(rows.filter((r) => r.itemId).map((r) => [r.id, r.itemId as string]))
}

/** The same check, for lines that name another document's line rather than the item. */
export async function assertLineQtyFitsUnits(
  db: Db,
  kind: LineKind,
  lines: Array<{ lineId: string; qty: QtyCheck['qty']; what?: string }>,
): Promise<void> {
  const itemOf = await itemsOfLines(db, kind, lines.map((l) => l.lineId))
  await assertQtyFitsUnits(
    db,
    lines.flatMap((l) => (itemOf.has(l.lineId) ? [{ itemId: itemOf.get(l.lineId)!, qty: l.qty, what: l.what }] : [])),
  )
}

/** Up to what can actually be asked for or bought: 2.1 cartons becomes 3. */
export const qtyUp = (qty: number, places: number) => roundUpToPlaces(qty, places)
/** Down to what can actually be handed over: 0.6 of a carton on the shelf gives 0. */
export const qtyDown = (qty: number, places: number) => roundDownToPlaces(qty, places)

// ── Packs: an item bought in a box of 20 pcs ──
//
// Every quantity a purchase document stores stays in the item's own unit (pcs),
// so stock, requisitions, receipts and bills always compare like with like. A
// line also remembers the pack it was entered in (uomId) and what one holds
// (uomFactor); its rate is per that pack, so a line's value is
// (qty ÷ uomFactor) × rate — 40 pcs in boxes of 20 at ₹99 a box is ₹198.

/** A line's quantity in the pack it was entered in: 40 pcs in boxes of 20 is 2. */
export const packQtyOf = (line: { qty: unknown; uomFactor?: unknown }) => {
  const f = Number(line.uomFactor ?? 1) || 1
  return Math.round((Number(line.qty) / f) * 1000) / 1000
}

/** A rate per pack as a rate per the item's own unit, for stock value: ₹99 a box of 20 is ₹4.95 a pc. */
export const stockRateOf = (rate: unknown, factor: unknown) => Number(rate) / (Number(factor ?? 1) || 1)

export interface ResolvedPack {
  /** The pack, or null for the item's own unit. */
  uomId: string | null
  factor: number
  /** Its symbol, and the item's own, for messages. */
  symbol: string
  stockSymbol: string
  /** Places after the point the pack itself is counted to (boxes: 0). */
  places: number
}

/**
 * The pack each line names, checked against the item's own "Bought in" list —
 * the server's sizes, never a factor the screen sent. No pack named, or the
 * item's own unit named: its own unit, factor 1.
 */
export async function resolvePacks(db: Db, lines: Array<{ itemId: string; uomId?: string | null }>): Promise<ResolvedPack[]> {
  const ids = [...new Set(lines.map((l) => l.itemId).filter(Boolean))]
  const items = ids.length
    ? await db.item.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          uomId: true,
          decimalPlaces: true,
          uom: { select: { symbol: true, decimalPlaces: true } },
          buyUnits: { select: { uomId: true, factor: true, uom: { select: { symbol: true, decimalPlaces: true } } } },
        },
      })
    : []
  const byId = new Map(items.map((i) => [i.id, i]))
  return lines.map((l) => {
    const item = byId.get(l.itemId)
    const own: ResolvedPack = { uomId: null, factor: 1, symbol: item?.uom.symbol ?? '', stockSymbol: item?.uom.symbol ?? '', places: qtyPlaces(item) }
    if (!item || !l.uomId || l.uomId === item.uomId) return own
    const pack = item.buyUnits.find((u) => u.uomId === l.uomId)
    if (!pack) {
      throw new AppError(
        `${item.name} is not bought in that unit. Add it under Masters → Items → Bought in, or enter the line in ${item.uom.symbol}.`,
        400,
        'NOT_A_PACK',
      )
    }
    return { uomId: l.uomId, factor: Number(pack.factor), symbol: pack.uom.symbol, stockSymbol: item.uom.symbol, places: qtyPlaces({ uom: pack.uom }) }
  })
}

/**
 * Lines as typed (in their packs) made ready to store: each one's quantity in
 * the item's own unit, its pack and what one holds. A pack quantity is checked
 * against the pack (2.5 boxes refused), the stock quantity against the item.
 */
export async function packLines<L extends { itemId: string; uomId?: string | null }>(
  db: Db,
  lines: L[],
  qtyFields: Array<keyof L>,
  what: string,
): Promise<Array<L & { pack: ResolvedPack }>> {
  const packs = await resolvePacks(db, lines)
  lines.forEach((l, i) => {
    const p = packs[i]
    for (const f of qtyFields) {
      const v = l[f]
      if (v == null || String(v).trim() === '') continue
      if (!fitsPlaces(Number(v), p.places)) {
        throw new AppError(`${what}: ${Number(v)} ${p.symbol}. ${placesMessage(p.places)}`, 400, 'QTY_NOT_IN_UNIT')
      }
    }
  })
  return lines.map((l, i) => ({ ...l, pack: packs[i] }))
}

/** A quantity typed in a pack, in the item's own unit: 2 boxes of 20 is 40. */
export const toStock = (qty: unknown, pack: { factor: number }) => Math.round(Number(qty) * pack.factor * 1000) / 1000
