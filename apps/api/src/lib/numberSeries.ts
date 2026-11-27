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
 * Purchase orders have rules of their own (the user's, 27 Nov 2026):
 * - Purchase orders and service purchase orders share the one PO series, and
 *   numbers run on from the last one: PO-0005 the last, the next is PO-0006.
 *   Gaps further down are not filled.
 * - Deleting offers two ways. Moved to the recycle bin, an order keeps its
 *   number until it is restored or deleted for good — nothing else gets it.
 *   Deleted for good, it frees its number; when it was the newest the count
 *   steps back, so the next order takes that number again.
 * - Only a draft never sent can be deleted. An order the supplier has had is
 *   cancelled instead: it stays on record and its number is never reused.
 * - Orders already made are never renumbered or re-labelled.
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
 * Whether a purchase order is a draft that never went to the supplier (nor
 * was approved) — the only kind that may be deleted. Anything else is
 * cancelled instead, and its number stays on record. For orders from before
 * `sentAt` was kept, ask `sentInHistory` too.
 */
export const neverSent = (po: { status: string; sentAt?: Date | null; approvedAt?: Date | null }) =>
  po.status === 'DRAFT' && !po.sentAt && !po.approvedAt

/**
 * Of these orders, the ones the activity log shows as sent once. `sentAt` is
 * kept from 27 Nov 2026; a draft put back to Draft before then has no date of
 * its own, and orders already made are not written to.
 */
export async function sentInHistory(tx: Prisma.TransactionClient, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const rows = await tx.auditLog.findMany({
    where: { entityType: 'PurchaseOrder', entityId: { in: ids }, after: { path: ['status'], equals: 'SENT' } },
    select: { entityId: true },
    distinct: ['entityId'],
  })
  return new Set(rows.map((r) => r.entityId))
}

type PoSeries = { prefix: string; separator: string; financialYear: string; lastNumber: number; padding: number }

/**
 * Which of these PO numbers an order holds — one on the books, or one in the
 * recycle bin, which keeps its number until it is restored or deleted for
 * good. A bin row that gave its number back under the earlier rule (stored
 * with `RELEASED_MARK`) still holds the number it shows.
 */
async function poNumbersHeld(tx: Prisma.TransactionClient, numbers: string[]): Promise<Set<string>> {
  const held = new Set(await numbersInUse(tx, 'PO', numbers))
  const wanted = new Set(numbers)
  const released = await tx.purchaseOrder.findMany({
    where: { poNumber: { contains: RELEASED_MARK } },
    select: { poNumber: true },
  })
  for (const r of released) if (wanted.has(shownNumber(r.poNumber))) held.add(shownNumber(r.poNumber))
  return held
}

/**
 * The number after the last one issued, stepping over any an order already
 * holds past it (a bin row from the earlier rule can).
 */
async function nextUnusedNumber(tx: Prisma.TransactionClient, series: PoSeries): Promise<{ number: string; lastNumber: number }> {
  for (let start = series.lastNumber + 1; ; start += 50) {
    const batch = Array.from({ length: 50 }, (_, i) => ({
      lastNumber: start + i,
      number: formatDocumentNumber({ ...series, lastNumber: start + i }),
    }))
    const held = await poNumbersHeld(tx, batch.map((b) => b.number))
    const next = batch.find((b) => !held.has(b.number))
    if (next) return next
  }
}

/**
 * The number a new purchase order (or service purchase order) takes: the one
 * after the last in its financial year's PO series.
 *
 * The series row is locked first, so two orders saved at the same moment take
 * their numbers one after the other; `poNumber` is unique besides.
 */
export async function nextPurchaseOrderNumber(tx: Prisma.TransactionClient, documentDate: Date = new Date()): Promise<string> {
  const series = await seriesFor(tx, 'PO', documentDate)
  await tx.$queryRaw`SELECT id FROM ld_erp.number_series WHERE id = ${series.id} FOR UPDATE`
  const locked = await tx.numberSeries.findUniqueOrThrow({ where: { id: series.id } })
  const next = await nextUnusedNumber(tx, locked)
  await tx.numberSeries.update({ where: { id: locked.id }, data: { lastNumber: next.lastNumber } })
  return checkedNumber(next.number)
}

/**
 * After a purchase order is deleted for good. When it carried the last number
 * issued, the count steps back to the last number an order still holds (on
 * the books or in the bin), so the next order runs on from there: PO-0004,
 * the newest, deleted for good — the next order is PO-0004. Never below
 * `reuseFloor`, so numbers skipped in Settings stay skipped. A number from the
 * middle stays a gap.
 */
export async function stepBackPurchaseOrderNumber(tx: Prisma.TransactionClient, number: string): Promise<void> {
  for (const s of await tx.numberSeries.findMany({ where: { docType: 'PO' } })) {
    if (s.lastNumber < 1 || formatDocumentNumber(s) !== number) continue
    await tx.$queryRaw`SELECT id FROM ld_erp.number_series WHERE id = ${s.id} FOR UPDATE`
    const locked = await tx.numberSeries.findUniqueOrThrow({ where: { id: s.id } })
    // An order saved a moment ago has moved the count on: this one is a gap now.
    if (formatDocumentNumber(locked) !== number) return
    let last = locked.reuseFloor
    for (let top = locked.lastNumber - 1; top > locked.reuseFloor; top -= 1000) {
      const ks = Array.from({ length: Math.min(1000, top - locked.reuseFloor) }, (_, i) => top - i)
      const held = await poNumbersHeld(tx, ks.map((k) => formatDocumentNumber({ ...locked, lastNumber: k })))
      const k = ks.find((k) => held.has(formatDocumentNumber({ ...locked, lastNumber: k })))
      if (k !== undefined) {
        last = k
        break
      }
    }
    await tx.numberSeries.update({ where: { id: locked.id }, data: { lastNumber: last } })
    return
  }
}

/** What a series will give next, without taking it — for Settings and the order form's preview. */
export async function peekNextNumber(
  tx: Prisma.TransactionClient,
  series: { docType: string; prefix: string; separator: string; financialYear: string; lastNumber: number; padding: number },
): Promise<string> {
  if (series.docType === 'PO') return (await nextUnusedNumber(tx, series)).number
  return formatDocumentNumber({ ...series, lastNumber: series.lastNumber + 1 })
}
