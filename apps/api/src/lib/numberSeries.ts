import type { Prisma } from '@prisma/client'
import { checkedNumber, formatDocumentNumber, seriesFor } from './docNumber'

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
 *
 * Purchase orders go further (the user's rules, 27 Nov 2026). Purchase orders
 * and service purchase orders share the one PO series, and each new order
 * takes the LOWEST free number of it — so a draft deleted from the middle
 * (PO-0002 between 0001 and 0003) gives its number to the next order. Only a
 * draft never sent gives its number back: an order the supplier has had can
 * only be cancelled, and its number stays on record. See nextPurchaseOrderNumber.
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

/**
 * Whether a purchase order may be deleted and give its number back: a draft
 * that was never sent to the supplier (nor approved). Anything else is
 * cancelled instead, and its number is never given out again.
 */
export const neverSent = (po: { status: string; sentAt?: Date | null; approvedAt?: Date | null }) =>
  po.status === 'DRAFT' && !po.sentAt && !po.approvedAt

/**
 * The lowest number of a series that no document carries, above its
 * `reuseFloor` and up to the last one issued; null when there is none. A
 * number a binned draft gave back is free (its row is re-labelled), and so is
 * one that was never used at all.
 */
export async function lowestFreeNumber(
  tx: Prisma.TransactionClient,
  docType: string,
  series: { prefix: string; separator: string; financialYear: string; lastNumber: number; padding: number; reuseFloor: number },
): Promise<string | null> {
  const from = Math.max(1, series.reuseFloor + 1)
  for (let start = from; start <= series.lastNumber; start += 1000) {
    const batch = Array.from({ length: Math.min(1000, series.lastNumber - start + 1) }, (_, i) =>
      formatDocumentNumber({ ...series, lastNumber: start + i }),
    )
    const used = new Set(await numbersInUse(tx, docType, batch))
    const free = batch.find((n) => !used.has(n))
    if (free) return free
  }
  return null
}

/**
 * The first number after the last one issued that no document carries. An
 * order can hold one past the count — an order the supplier had keeps its
 * number in the recycle bin even where the count was stepped back for it —
 * and that number is stepped over, never issued twice.
 */
async function nextUnusedNumber(
  tx: Prisma.TransactionClient,
  docType: string,
  series: { prefix: string; separator: string; financialYear: string; lastNumber: number; padding: number },
): Promise<{ number: string; lastNumber: number }> {
  for (let start = series.lastNumber + 1; ; start += 50) {
    const batch = Array.from({ length: 50 }, (_, i) => ({
      lastNumber: start + i,
      number: formatDocumentNumber({ ...series, lastNumber: start + i }),
    }))
    const used = new Set(await numbersInUse(tx, docType, batch.map((b) => b.number)))
    const next = batch.find((b) => !used.has(b.number))
    if (next) return next
  }
}

/**
 * The number a new purchase order (or service purchase order) takes: the
 * lowest free one in its financial year's PO series, else the next.
 *
 * The series row is locked first, so two orders saved at the same moment
 * take their numbers one after the other and can never pick the same free
 * one; `poNumber` is unique besides.
 */
export async function nextPurchaseOrderNumber(tx: Prisma.TransactionClient, documentDate: Date = new Date()): Promise<string> {
  const series = await seriesFor(tx, 'PO', documentDate)
  await tx.$queryRaw`SELECT id FROM ld_erp.number_series WHERE id = ${series.id} FOR UPDATE`
  const locked = await tx.numberSeries.findUniqueOrThrow({ where: { id: series.id } })
  const free = await lowestFreeNumber(tx, 'PO', locked)
  if (free) return checkedNumber(free)
  const next = await nextUnusedNumber(tx, 'PO', locked)
  await tx.numberSeries.update({ where: { id: locked.id }, data: { lastNumber: next.lastNumber } })
  return checkedNumber(next.number)
}

/** What a series will give next, without taking it — for Settings and the order form's preview. */
export async function peekNextNumber(
  tx: Prisma.TransactionClient,
  series: { docType: string; prefix: string; separator: string; financialYear: string; lastNumber: number; padding: number; reuseFloor: number },
): Promise<string> {
  if (series.docType === 'PO') {
    return (await lowestFreeNumber(tx, 'PO', series)) ?? (await nextUnusedNumber(tx, 'PO', series)).number
  }
  return formatDocumentNumber({ ...series, lastNumber: series.lastNumber + 1 })
}
