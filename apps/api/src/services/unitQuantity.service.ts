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
export type LineKind = 'poLine' | 'grnLine' | 'billLine' | 'mrLine' | 'customerGrnLine' | 'jobWorkLine' | 'enquiryLine' | 'package'

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
