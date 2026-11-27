import type { Prisma } from '@prisma/client'
import { formatDocumentNumber } from './docNumber'

/**
 * Giving numbers back, and keeping them unique (the user's rules, 27 Nov 2026).
 *
 * - Deleting the NEWEST document of a series gives its number back: the series
 *   steps back one and the next document takes that number. Deleting one in
 *   the middle leaves its gap — reusing it would put a later date on an
 *   earlier number.
 * - A document deleted to a recycle bin keeps a row, and document numbers are
 *   unique, so when it gives its number back the row is re-labelled with
 *   `RELEASED_MARK`. Restored, it takes its own number again when that is still
 *   free, or a fresh one when another document has it now.
 * - The next number can be set in Settings, but never so that a number already
 *   on a document would be issued again.
 */

export const RELEASED_MARK = '~released-'

/** The number a document shows, with any released mark taken off. */
export const shownNumber = (stored: string) => stored.split(RELEASED_MARK)[0]

/** What a row that gave its number back is stored under. */
export const releasedNumber = (number: string) => `${number}${RELEASED_MARK}${Date.now().toString(36)}`

/**
 * Where each series' numbers live, so a number can be checked against every
 * document that might carry it. A series not listed here can still be moved
 * forward, never back.
 */
const SERIES_TABLES: Record<string, Array<[delegate: string, field: string, where?: Record<string, unknown>]>> = {
  SO: [['salesOrder', 'soNumber']],
  QT: [['salesQuotation', 'quoteNumber']],
  INV: [['salesInvoice', 'invoiceNumber']],
  DC: [['deliveryChallan', 'dcNumber']],
  RCPT: [['paymentReceipt', 'receiptNumber']],
  CN: [['creditNote', 'noteNumber']],
  ENQ: [['purchaseEnquiry', 'enquiryNumber']],
  PO: [['purchaseOrder', 'poNumber']],
  GRN: [['gRN', 'grnNumber']],
  PB: [['purchaseInvoice', 'billNumber']],
  SP: [['supplierPayment', 'paymentNumber']],
  DN: [['debitNote', 'noteNumber'], ['purchaseNote', 'noteNumber']],
  SCN: [['purchaseNote', 'noteNumber']],
  SDN: [['purchaseNote', 'noteNumber']],
  PADJ: [['purchaseNote', 'noteNumber']],
  PRC: [['purchaseReturn', 'returnNumber']],
  MR: [['materialRequisition', 'mrNumber']],
  FR: [['floorReturn', 'returnNumber']],
  STN: [['stockTransfer', 'transferNumber']],
  ADJ: [['stockAdjustment', 'adjustmentNumber']],
  SC: [['stockCount', 'countNumber']],
  CGRN: [['customerGRN', 'grnNumber']],
  CMR: [['customerMaterialReturn', 'returnNumber']],
  JW: [['jobWorkChallan', 'challanNumber']],
  JWR: [['jobWorkReturn', 'returnNumber']],
  MO: [['manufacturingOrder', 'moNumber']],
  FGR: [['finishedGoodsReceipt', 'fgrNumber']],
  PV: [['voucher', 'voucherNo', { kind: 'PAYMENT' }]],
  RV: [['voucher', 'voucherNo', { kind: 'RECEIPT' }]],
  CV: [['voucher', 'voucherNo', { kind: 'CONTRA' }]],
  JV: [['voucher', 'voucherNo', { kind: 'JOURNAL' }]],
}

/** Whether the series' numbers can be checked against its documents. */
export const seriesIsChecked = (docType: string) => docType in SERIES_TABLES

/** Which of these numbers a document of this series already carries. */
export async function numbersInUse(
  tx: Prisma.TransactionClient,
  docType: string,
  numbers: string[],
): Promise<string[]> {
  const tables = SERIES_TABLES[docType] ?? []
  const used = new Set<string>()
  for (const [delegate, field, where] of tables) {
    const rows: Array<Record<string, string>> = await (tx as any)[delegate].findMany({
      where: { ...where, [field]: { in: numbers } },
      select: { [field]: true },
    })
    for (const r of rows) used.add(r[field])
  }
  return numbers.filter((n) => used.has(n))
}

/**
 * Gives a deleted document's number back when it is the newest its series has
 * issued. Returns whether it did — the caller then re-labels a binned row.
 */
export async function releaseDocumentNumber(
  tx: Prisma.TransactionClient,
  docType: string,
  number: string,
): Promise<boolean> {
  const series = await tx.numberSeries.findMany({ where: { docType } })
  const newest = series.find((s) => s.lastNumber > 0 && formatDocumentNumber(s) === number)
  if (!newest) return false
  // Guarded on the count it was read at, so a number issued a moment ago is
  // never given out twice.
  const stepped = await tx.numberSeries.updateMany({
    where: { id: newest.id, lastNumber: newest.lastNumber },
    data: { lastNumber: { decrement: 1 } },
  })
  return stepped.count === 1
}

/**
 * Takes a restored document's own number back when no other document carries
 * it and its series has already issued it (or is about to — then the series
 * moves on past it). Returns false when a fresh number is needed instead.
 */
export async function reclaimDocumentNumber(
  tx: Prisma.TransactionClient,
  docType: string,
  number: string,
): Promise<boolean> {
  if ((await numbersInUse(tx, docType, [number])).length) return false
  for (const s of await tx.numberSeries.findMany({ where: { docType } })) {
    const k = Number(number.slice(-s.padding))
    if (!Number.isInteger(k) || formatDocumentNumber({ ...s, lastNumber: k }) !== number) continue
    if (k === s.lastNumber + 1) {
      await tx.numberSeries.update({ where: { id: s.id }, data: { lastNumber: { increment: 1 } } })
      return true
    }
    return k <= s.lastNumber
  }
  return false
}
