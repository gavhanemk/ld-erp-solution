import { Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'

/**
 * What stock is free to take: the one rule every screen, report and check
 * uses — the requisition list, the fulfil window, holds, the MO's material
 * plan, the Stock Summary and the stock screen.
 *
 * A store offers its stock only when it is a store goods are issued from:
 * never a sample store (that material is the sample's), and never one kept
 * for goods held for QC, rejected, scrapped or on their way. Of what such a
 * store holds, only good stock (grade A) is on offer: B-grade and rejected
 * goods are counted, never offered. Stock held for a requisition is set aside
 * for it. So:
 *
 *   free = good stock in stores that issue − held for other requisition lines
 *
 * Physical stock — everything the ledger holds, every grade in every store —
 * is still counted and valued as it always was; this only says what is free.
 */

/** Kinds of store whose stock is counted but never offered. */
export const NOT_OFFERED_KINDS = ['QC_HOLD', 'REJECTED', 'SCRAP', 'TRANSIT', 'SAMPLE'] as const

/** The stores whose stock is on offer, as a Prisma filter on a warehouse. */
export const offeringStore: Prisma.WarehouseWhereInput = {
  purpose: { not: 'SAMPLING' },
  kind: { notIn: [...NOT_OFFERED_KINDS] },
}

/** Good stock in a store that offers it, as a Prisma filter on stock ledger rows. */
export const offeredStock: Prisma.StockLedgerWhereInput = { grade: 'A', warehouse: offeringStore }

/**
 * The same rule as SQL, for a raw query over the stock ledger (`s`) joined
 * to its warehouse (`w`): good stock in a store that offers it.
 */
export const offeredSql = (s = 's', w = 'w') =>
  Prisma.raw(
    `${s}.grade = 'A' AND ${w}.purpose::text <> 'SAMPLING' AND ${w}.kind::text NOT IN (${NOT_OFFERED_KINDS.map((k) => `'${k}'`).join(', ')})`,
  )

/** The ids of every store that offers its stock, for a raw query: `s."warehouseId" IN (${OFFERING_STORE_IDS})`. */
export const OFFERING_STORE_IDS = Prisma.raw(
  `SELECT ow.id FROM ld_erp.warehouses ow WHERE ow.purpose::text <> 'SAMPLING' AND ow.kind::text NOT IN (${NOT_OFFERED_KINDS.map((k) => `'${k}'`).join(', ')})`,
)

/** How a store that does not offer its stock is described: "a reject store". */
export const KIND_WORDS: Record<string, string> = {
  QC_HOLD: 'a QC hold store',
  REJECTED: 'a reject store',
  SCRAP: 'a scrap store',
  TRANSIT: 'an in-transit store',
  SAMPLE: 'a sample store',
}

/** Whether a store offers its stock. */
export function storeOffers(w: { purpose?: string | null; kind?: string | null }): boolean {
  return w.purpose !== 'SAMPLING' && !(NOT_OFFERED_KINDS as readonly string[]).includes(String(w.kind ?? 'GENERAL'))
}

/**
 * Refuses to issue or hold from a store that does not offer its stock — a
 * reject, QC hold, scrap or in-transit store. `rule` says what to do instead.
 */
export async function assertStoresOffer(
  tx: Prisma.TransactionClient,
  warehouseIds: Array<string | null | undefined>,
  rule: string,
): Promise<void> {
  const ids = [...new Set(warehouseIds.filter((id): id is string => !!id))]
  if (!ids.length) return
  const stores = await tx.warehouse.findMany({ where: { id: { in: ids } }, select: { name: true, kind: true, purpose: true } })
  const shut = stores.find((w) => w.purpose !== 'SAMPLING' && !storeOffers(w))
  if (shut) {
    throw new AppError(`${shut.name} is ${KIND_WORDS[shut.kind] ?? 'a store whose stock is not offered'}: nothing is issued or held from it. ${rule}`, 409, 'STORE_NOT_OFFERED')
  }
}
