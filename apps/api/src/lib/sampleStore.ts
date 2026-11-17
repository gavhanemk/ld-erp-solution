import { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * A sample store (Warehouse.purpose SAMPLING) keeps material bought for a
 * sample apart from bulk stock. The warehouse is part of every balance, lock
 * and average, so the two never blend; these rules keep general documents
 * from reaching into it.
 *
 * What may move stock in or out of a sample store, checked by the one stock
 * writer (recordMovement) for every movement whatever document asks:
 *
 *   - receipts against orders (the receipt itself puts only sample-linked
 *     order lines here, and nothing else), their corrections, cancellations,
 *     inspections and returns to the supplier;
 *   - Sampling's own issues and returns;
 *   - the store's own counts and adjustments, which state a fact;
 *   - the buyer's own material sent for a sample: received, released,
 *     cancelled and returned to them, while it stays the buyer's.
 *
 * Everything else — a requisition issue, a transfer, job work, opening
 * stock, a stock-in, cutting, despatch — is refused, naming the store.
 */
const SAMPLE_STORE_DOCUMENTS: ReadonlySet<string> = new Set([
  'GRN',
  'GRN_EDITED',
  'GRN_CANCELLED',
  'GRN_DELETED',
  'GRN_QC',
  'GRN_QC_CANCELLED',
  'GRN_QC_USED',
  'PurchaseReturn',
  'PurchaseNote',
  'SAMPLING',
  'STOCK_COUNT',
  'STOCK_ADJUSTMENT',
])
const BUYER_DOCUMENTS: ReadonlySet<string> = new Set([
  'CUSTOMER_GRN',
  'CUSTOMER_GRN_RELEASE',
  'CUSTOMER_GRN_CANCELLED',
  'CUSTOMER_RETURN',
  'CUSTOMER_RETURN_CANCELLED',
])

/** Whether a movement may touch a sample store. */
export function sampleStoreMayMove(m: { referenceType: string; ownership?: string | null }) {
  if (SAMPLE_STORE_DOCUMENTS.has(m.referenceType)) return true
  return BUYER_DOCUMENTS.has(m.referenceType) && m.ownership === 'CUSTOMER_OWNED'
}

/** The document a refused movement came from, as a store keeper says it. */
const DOCUMENT_WORDS: Record<string, string> = {
  MATERIAL_REQUISITION: 'A requisition issue',
  MR_RETURN: 'A return from the floor',
  MR_RETURN_CANCELLED: 'A return from the floor',
  STOCK_TRANSFER: 'A stock transfer',
  STOCK_TRANSFER_CANCELLED: 'A stock transfer',
  JOB_WORK_CHALLAN: 'A job-work challan',
  JOB_WORK_CHALLAN_CANCELLED: 'A job-work challan',
  JOB_WORK_RETURN: 'A job-work return',
  JOB_WORK_RETURN_CANCELLED: 'A job-work return',
  OPENING_STOCK: 'Opening stock',
  STOCK_IN: 'A stock-in',
  CUTTING: 'Cutting',
  CUTTING_CANCEL: 'Cutting',
  DELIVERY_CHALLAN: 'A delivery challan',
  DELIVERY_CHALLAN_CANCEL: 'A delivery challan',
  FG_RECEIPT: 'A finished-goods receipt',
  FG_RECEIPT_CANCEL: 'A finished-goods receipt',
  CREDIT_NOTE: 'A credit note',
  CREDIT_NOTE_CANCEL: 'A credit note',
}

/** The refusal recordMovement gives a general document reaching into a sample store. */
export function sampleStoreRefused(store: string, referenceType: string, ownership?: string | null) {
  const what =
    DOCUMENT_WORDS[referenceType] ??
    (BUYER_DOCUMENTS.has(referenceType) && ownership !== 'CUSTOMER_OWNED'
      ? 'Our own stock on a buyer’s document'
      : 'This document')
  return new AppError(
    `${store} is a sample store: it keeps material bought for samples apart from bulk stock. ${what} cannot move stock in or out of it. Use a general store.`,
    409,
    'SAMPLE_STORE'
  )
}

/**
 * Refuses sample stores among `warehouseIds`, for a document that has no stock
 * movement of its own to be refused by yet: a requisition naming its store, a
 * hold kept on the rack. `rule` says what the document may use instead.
 */
export async function assertGeneralStores(
  tx: Prisma.TransactionClient,
  warehouseIds: Array<string | null | undefined>,
  rule: string
) {
  const ids = [...new Set(warehouseIds.filter((id): id is string => !!id))]
  if (!ids.length) return
  const sample = await tx.warehouse.findMany({
    where: { id: { in: ids }, purpose: 'SAMPLING' },
    select: { name: true },
    orderBy: { name: 'asc' },
  })
  if (!sample.length) return
  const names = sample.map((w) => w.name).join(' and ')
  throw new AppError(
    `${names} ${sample.length === 1 ? 'is a sample store' : 'are sample stores'}: material bought for samples is kept there apart from bulk stock. ${rule}`,
    409,
    'SAMPLE_STORE'
  )
}

/** The ids of every sample store, for a raw query to leave them out of general stock. */
export const SAMPLE_STORE_IDS = Prisma.sql`SELECT w.id FROM ld_erp.warehouses w WHERE w.purpose = 'SAMPLING'`

/** The sample stores in use, by name: where sample purchases are delivered and received. */
export function activeSampleStores(tx: Prisma.TransactionClient) {
  return tx.warehouse.findMany({
    where: { purpose: 'SAMPLING', isActive: true },
    select: { id: true, name: true, code: true },
    orderBy: { name: 'asc' },
  })
}
