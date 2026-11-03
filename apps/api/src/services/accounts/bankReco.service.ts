import type { Prisma } from '@prisma/client'
import { AppError } from '../../middleware/errorHandler'
import { booksSettings, dayValue, fyStartOf, istDay, KIND_LABEL, ledgerFigures, r2, todayIst } from './books.service'
import { moneyGroupIds } from './voucher.service'

/**
 * Bank reconciliation: the books against the bank statement.
 *
 * Every line on a bank ledger gets the day the bank shows it — its bank date
 * — once it appears on the statement. On any day, what the books say less the
 * deposits the bank has not credited yet, plus the cheques it has not paid
 * yet, is what the bank should say. If the statement says something else,
 * the difference is a line the books are missing (bank charges, interest, a
 * returned cheque) or one entered wrongly.
 */

type Tx = Prisma.TransactionClient

export async function bankReco(tx: Tx, ledgerId: string, asOn: string) {
  const ledger = await tx.ledger.findUnique({
    where: { id: ledgerId },
    select: { id: true, name: true, groupId: true, bankAccount: { select: { accountNumber: true, ifscCode: true } } },
  })
  if (!ledger) throw new AppError('Ledger not found', 404, 'NOT_FOUND')
  if (!(await moneyGroupIds(tx)).has(ledger.groupId) || !ledger.bankAccount) {
    throw new AppError(`${ledger.name} is not a bank account`, 400, 'NOT_A_BANK')
  }
  const s = await booksSettings(tx)
  const [figures] = await ledgerFigures(tx, { from: fyStartOf(asOn, s.fyStartMonth), to: asOn }, s, ledgerId)
  const end = new Date(`${asOn}T23:59:59.999+05:30`)
  const monthStart = dayValue(`${asOn.slice(0, 8)}01`)
  const lines = await tx.voucherLine.findMany({
    where: {
      ledgerId,
      voucher: { status: 'POSTED', date: { lte: end } },
      // Not yet in the bank on the day, or cleared this month (to see and undo).
      OR: [{ bankDate: null }, { bankDate: { gt: dayValue(asOn) } }, { bankDate: { gte: monthStart } }],
    },
    orderBy: [{ voucher: { date: 'asc' } }, { voucher: { createdAt: 'asc' } }],
    select: {
      id: true,
      debit: true,
      credit: true,
      bankDate: true,
      voucher: {
        select: {
          id: true,
          kind: true,
          voucherNo: true,
          date: true,
          narration: true,
          chequeNo: true,
          referenceNo: true,
          mode: true,
          lines: { select: { id: true, debit: true, credit: true, ledger: { select: { name: true } } } },
        },
      },
    },
  })
  const rows = lines.map((l) => {
    const debit = Number(l.debit)
    const others = l.voucher.lines.filter((o) => o.id !== l.id && (debit > 0 ? Number(o.credit) > 0 : Number(o.debit) > 0))
    const bankDate = l.bankDate ? istDay(l.bankDate) : null
    return {
      lineId: l.id,
      voucherId: l.voucher.id,
      date: istDay(l.voucher.date),
      kind: l.voucher.kind,
      kindLabel: KIND_LABEL[l.voucher.kind],
      voucherNo: l.voucher.voucherNo,
      particulars: others.length === 0 ? '—' : others.length === 1 ? others[0].ledger.name : `${others[0].ledger.name} + ${others.length - 1} more`,
      narration: l.voucher.narration,
      chequeNo: l.voucher.chequeNo,
      referenceNo: l.voucher.referenceNo,
      mode: l.voucher.mode,
      /** Into the bank. */
      deposit: debit,
      /** Out of the bank. */
      withdrawal: Number(l.credit),
      bankDate,
      cleared: !!bankDate && bankDate <= asOn,
    }
  })
  const pending = rows.filter((r) => !r.cleared)
  const notCredited = r2(pending.reduce((t, r) => t + r.deposit, 0))
  const notDebited = r2(pending.reduce((t, r) => t + r.withdrawal, 0))
  const books = figures?.closing ?? 0
  return {
    ledger: { id: ledger.id, name: ledger.name, accountNumber: ledger.bankAccount.accountNumber, ifscCode: ledger.bankAccount.ifscCode },
    asOn,
    /** Debit positive: money in the bank by the books. */
    booksBalance: books,
    notCredited,
    notDebited,
    bankBalance: r2(books - notCredited + notDebited),
    pending,
    clearedThisMonth: rows.filter((r) => r.cleared),
  }
}

/**
 * Sets, or clears, the bank date on bank lines. A line cannot be in the bank
 * before its voucher was written, nor after today.
 */
export async function setBankDates(tx: Tx, entries: Array<{ lineId: string; bankDate: string | null }>) {
  const lines = await tx.voucherLine.findMany({
    where: { id: { in: entries.map((e) => e.lineId) } },
    select: { id: true, ledger: { select: { name: true, bankAccountId: true } }, voucher: { select: { voucherNo: true, date: true, status: true } } },
  })
  const byId = new Map(lines.map((l) => [l.id, l]))
  const today = todayIst()
  for (const e of entries) {
    const l = byId.get(e.lineId)
    if (!l) throw new AppError('That entry no longer exists; refresh the page.', 404, 'NOT_FOUND')
    if (!l.ledger.bankAccountId) throw new AppError(`${l.voucher.voucherNo} on ${l.ledger.name} is not a bank entry`, 400, 'NOT_A_BANK')
    if (l.voucher.status !== 'POSTED') throw new AppError(`${l.voucher.voucherNo} is cancelled`, 409, 'CANCELLED')
    if (e.bankDate) {
      const written = istDay(l.voucher.date)
      if (e.bankDate < written) throw new AppError(`${l.voucher.voucherNo} is dated ${written}; the bank cannot show it before that.`, 400, 'BEFORE_VOUCHER')
      if (e.bankDate > today) throw new AppError(`A bank date cannot be after today (${l.voucher.voucherNo}).`, 400, 'FUTURE_DATE')
    }
  }
  for (const e of entries) {
    await tx.voucherLine.update({ where: { id: e.lineId }, data: { bankDate: e.bankDate ? dayValue(e.bankDate) : null } })
  }
  return entries.length
}
