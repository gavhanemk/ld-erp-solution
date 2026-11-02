import { z } from 'zod'
import type { BillRefKind, Prisma, VoucherKind } from '@prisma/client'
import { AppError } from '../../middleware/errorHandler'
import { financialYearOf, nextDocumentNumber } from '../../lib/docNumber'
import { VOUCHER_SERIES } from './chart.service'
import { booksSettings, dayValue, istDay, openBills, r2, todayIst, type BooksSettings } from './books.service'

/**
 * Vouchers typed in Accounts: Payment, Receipt, Contra and Journal.
 *
 * Each is checked whole before anything is written, and its number is taken
 * last, so a refused voucher uses none. The rules are the ones an accountant
 * expects of SAB or Tally:
 *
 *   - debits equal credits, to the paisa;
 *   - a Payment pays out of cash or a bank, a Receipt brings money into one,
 *     a Contra only moves money between them, and a Journal never touches
 *     them — so the cash book holds every rupee in and out, and nothing else;
 *   - a line on a party whose bills are kept one by one says which bills it
 *     raises or settles, and cannot settle more of a bill than is left;
 *   - nothing before the day the books start, nothing in a closed period,
 *     nothing dated after today;
 *   - a brand (cost centre) goes on income and expense lines only.
 *
 * Nothing is deleted. A voucher is altered — the audit trail keeps what it
 * said before — or cancelled with a reason, keeping its number.
 */

type Tx = Prisma.TransactionClient

export const MANUAL_KINDS = ['PAYMENT', 'RECEIPT', 'CONTRA', 'JOURNAL'] as const
export type ManualKind = (typeof MANUAL_KINDS)[number]
const MODES = ['CASH', 'CHEQUE', 'NEFT', 'RTGS', 'UPI', 'PDC'] as const
const ymd = (what: string) => z.string({ required_error: `Put the ${what} in` }).regex(/^\d{4}-\d{2}-\d{2}$/, `The ${what} is not a date`)
const money = (what: string) =>
  z
    .number({ invalid_type_error: `${what} has to be an amount` })
    .positive(`${what} has to be more than zero`)
    .max(99_999_999_999, 'That amount looks like a typo')

const billSchema = z.object({
  kind: z.enum(['NEW_REF', 'AGAINST_REF', 'ADVANCE', 'ON_ACCOUNT']),
  billNo: z.string().trim().max(40).optional().nullable(),
  dueDate: ymd('due date').optional().nullable(),
  amount: money('A bill amount'),
})

const lineSchema = z.object({
  ledgerId: z.string().min(1, 'Pick the ledger'),
  side: z.enum(['DR', 'CR']),
  amount: money('The amount'),
  costCentreId: z.string().optional().nullable(),
  narration: z.string().trim().max(500).optional().nullable(),
  bills: z.array(billSchema).max(100).optional(),
})

export const voucherSchema = z
  .object({
    kind: z.enum(MANUAL_KINDS),
    date: ymd('date'),
    narration: z.string().trim().max(1000).optional().nullable(),
    mode: z.enum(MODES).optional().nullable(),
    referenceNo: z.string().trim().max(60).optional().nullable(),
    chequeNo: z.string().trim().max(40).optional().nullable(),
    chequeDate: ymd('cheque date').optional().nullable(),
    lines: z.array(lineSchema).min(2, 'A voucher needs a debit and a credit').max(200),
  })
  .superRefine((v, ctx) => {
    const dr = r2(v.lines.filter((l) => l.side === 'DR').reduce((s, l) => s + l.amount, 0))
    const cr = r2(v.lines.filter((l) => l.side === 'CR').reduce((s, l) => s + l.amount, 0))
    if (dr !== cr) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: `Debits ₹${dr.toFixed(2)} and credits ₹${cr.toFixed(2)} do not agree` })
    }
    v.lines.forEach((l, i) => {
      if (!l.bills?.length) return
      const sum = r2(l.bills.reduce((s, b) => s + b.amount, 0))
      if (sum !== r2(l.amount)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'bills'],
          message: `The bills on line ${i + 1} add up to ₹${sum.toFixed(2)}, not the line's ₹${r2(l.amount).toFixed(2)}`,
        })
      }
      l.bills.forEach((b, j) => {
        if ((b.kind === 'NEW_REF' || b.kind === 'AGAINST_REF') && !b.billNo?.trim()) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines', i, 'bills', j, 'billNo'], message: 'Say which bill' })
        }
      })
    })
  })

export type VoucherInput = z.infer<typeof voucherSchema>

/** The groups whose ledgers are money: cash, bank, and the bank's overdraft or cash credit. */
const MONEY_GROUPS = ['CASH_IN_HAND', 'BANK_ACCOUNTS', 'BANK_OD']

/** Every group id at or under the money groups. */
export async function moneyGroupIds(tx: Tx): Promise<Set<string>> {
  const groups = await tx.ledgerGroup.findMany({ select: { id: true, parentId: true, systemKey: true } })
  const ids = new Set(groups.filter((g) => g.systemKey && MONEY_GROUPS.includes(g.systemKey)).map((g) => g.id))
  // Groups the mill adds under them count too.
  for (let grew = true; grew; ) {
    grew = false
    for (const g of groups) {
      if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
        ids.add(g.id)
        grew = true
      }
    }
  }
  return ids
}

/** The checks on the day: after the books start, outside a closed period, not in the future. */
export function checkDay(day: string, s: BooksSettings, what = 'A voucher') {
  if (!s.booksStart) {
    throw new AppError('Set the day the books start (Settings → Company) before entering vouchers.', 409, 'BOOKS_NOT_STARTED')
  }
  if (day < s.booksStart) {
    throw new AppError(`${what} cannot be dated before the books start on ${s.booksStart}.`, 400, 'BEFORE_BOOKS')
  }
  if (s.lockedUpTo && day <= s.lockedUpTo) {
    throw new AppError(`The books are closed up to ${s.lockedUpTo}. ${what} dated ${day} cannot be entered, changed or cancelled.`, 409, 'PERIOD_LOCKED')
  }
  if (day > todayIst()) {
    throw new AppError(`${what} cannot be dated after today.`, 400, 'FUTURE_DATE')
  }
}

interface Existing {
  id: string
  kind: VoucherKind
  voucherNo: string
  financialYear: string
  date: Date
}

/**
 * Checks a voucher and writes it: a new one, or a new version of `existing`.
 * Returns its id and number.
 */
export async function writeVoucher(tx: Tx, input: VoucherInput, userId: string, existing?: Existing): Promise<{ id: string; voucherNo: string }> {
  const s = await booksSettings(tx)
  checkDay(input.date, s)
  if (existing) {
    checkDay(istDay(existing.date), s, 'This voucher')
    if (existing.kind !== input.kind) {
      throw new AppError('A voucher keeps its type. Cancel it and enter the other type instead.', 400, 'KIND_FIXED')
    }
  }
  const date = dayValue(input.date)
  const financialYear = financialYearOf(date, s.fyStartMonth)
  if (existing && existing.financialYear !== financialYear) {
    throw new AppError(`${existing.voucherNo} belongs to ${existing.financialYear}; it cannot be moved into another financial year.`, 400, 'OTHER_YEAR')
  }

  // ── The ledgers, and what kind each is ──
  const ids = [...new Set(input.lines.map((l) => l.ledgerId))]
  const [ledgers, money] = await Promise.all([
    tx.ledger.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, isActive: true, billWise: true, groupId: true, group: { select: { nature: true } } },
    }),
    moneyGroupIds(tx),
  ])
  const byId = new Map(ledgers.map((l) => [l.id, l]))
  input.lines.forEach((l, i) => {
    const led = byId.get(l.ledgerId)
    if (!led) throw new AppError(`Line ${i + 1}: that ledger no longer exists`, 400, 'NO_LEDGER')
    if (!led.isActive) throw new AppError(`Line ${i + 1}: ${led.name} is switched off`, 400, 'LEDGER_INACTIVE')
  })
  const isMoney = (l: { ledgerId: string }) => money.has(byId.get(l.ledgerId)!.groupId)
  const dr = input.lines.filter((l) => l.side === 'DR')
  const cr = input.lines.filter((l) => l.side === 'CR')

  // ── What each voucher type may touch ──
  switch (input.kind) {
    case 'PAYMENT':
      if (!cr.some(isMoney)) throw new AppError('A payment goes out of cash or a bank: credit a cash or bank ledger.', 400, 'NEEDS_MONEY')
      if (dr.some(isMoney)) throw new AppError('Money moving between cash and a bank is a Contra voucher, not a payment.', 400, 'USE_CONTRA')
      break
    case 'RECEIPT':
      if (!dr.some(isMoney)) throw new AppError('A receipt comes into cash or a bank: debit a cash or bank ledger.', 400, 'NEEDS_MONEY')
      if (cr.some(isMoney)) throw new AppError('Money moving between cash and a bank is a Contra voucher, not a receipt.', 400, 'USE_CONTRA')
      break
    case 'CONTRA':
      if (!input.lines.every(isMoney)) throw new AppError('A contra only moves money between cash and bank ledgers. Use a Payment, Receipt or Journal for anything else.', 400, 'CONTRA_MONEY_ONLY')
      break
    case 'JOURNAL':
      if (input.lines.some(isMoney)) throw new AppError('Cash and bank go through Payment, Receipt or Contra, so the cash book holds every rupee. A journal cannot touch them.', 400, 'JOURNAL_NO_MONEY')
      break
  }

  // ── Brands ──
  const centreIds = [...new Set(input.lines.map((l) => l.costCentreId).filter((c): c is string => !!c))]
  const centres = centreIds.length ? await tx.costCentre.findMany({ where: { id: { in: centreIds } }, select: { id: true, name: true, isActive: true } }) : []
  input.lines.forEach((l, i) => {
    if (!l.costCentreId) return
    const c = centres.find((x) => x.id === l.costCentreId)
    if (!c || !c.isActive) throw new AppError(`Line ${i + 1}: that brand is not in use`, 400, 'NO_COST_CENTRE')
    const nature = byId.get(l.ledgerId)!.group.nature
    if (nature !== 'INCOME' && nature !== 'EXPENSE') {
      throw new AppError(`Line ${i + 1}: a brand goes on income and expense lines only, not on ${byId.get(l.ledgerId)!.name}.`, 400, 'COST_CENTRE_PL_ONLY')
    }
  })

  // ── Bills ──
  type Ref = { kind: BillRefKind; billNo: string | null; billDate: Date; dueDate: Date | null; amount: number }
  const refsByLine: Ref[][] = []
  const openCache = new Map<string, Awaited<ReturnType<typeof openBills>>>()
  /** What this voucher has already taken off each bill, so two lines cannot settle the same rupee twice. */
  const taken = new Map<string, number>()
  for (const [i, l] of input.lines.entries()) {
    const led = byId.get(l.ledgerId)!
    const sign = l.side === 'DR' ? 1 : -1
    if (!led.billWise) {
      if (l.bills?.length) throw new AppError(`Line ${i + 1}: ${led.name} is not kept bill by bill`, 400, 'NOT_BILL_WISE')
      refsByLine.push([])
      continue
    }
    const bills = l.bills?.length ? l.bills : [{ kind: 'ON_ACCOUNT' as const, billNo: null, dueDate: null, amount: l.amount }]
    const refs: Ref[] = []
    for (const b of bills) {
      const billNo = b.billNo?.trim() || null
      if (b.kind === 'AGAINST_REF') {
        if (!openCache.has(led.id)) openCache.set(led.id, await openBills(tx, led.id, existing?.id))
        const open = openCache.get(led.id)!.find((o) => o.billNo === billNo)
        if (!open) throw new AppError(`Line ${i + 1}: ${led.name} has no open bill ${billNo}`, 400, 'NO_SUCH_BILL')
        const key = `${led.id}:${billNo}`
        const left = r2(open.pending + (taken.get(key) ?? 0))
        const amount = r2(sign * b.amount)
        // Settling a bill works against it: a bill we are owed (debit) is settled by a credit.
        if (Math.sign(left) === Math.sign(amount)) {
          throw new AppError(`Line ${i + 1}: bill ${billNo} of ${led.name} is settled from the other side`, 400, 'WRONG_SIDE')
        }
        if (Math.abs(amount) > Math.abs(left) + 0.005) {
          throw new AppError(`Line ${i + 1}: only ₹${Math.abs(left).toFixed(2)} is left on bill ${billNo} of ${led.name}`, 400, 'OVER_SETTLED')
        }
        taken.set(key, r2((taken.get(key) ?? 0) + amount))
        refs.push({ kind: 'AGAINST_REF', billNo, billDate: dayValue(open.billDate), dueDate: open.dueDate ? dayValue(open.dueDate) : null, amount })
        continue
      }
      if (b.kind === 'NEW_REF') {
        const clash = await tx.billRef.findFirst({
          where: {
            ledgerId: led.id,
            billNo: billNo!,
            kind: { not: 'AGAINST_REF' },
            OR: [{ lineId: null }, { line: { voucher: { status: 'POSTED', ...(existing ? { id: { not: existing.id } } : {}) } } }],
          },
          select: { id: true },
        })
        if (clash || refs.some((r) => r.kind === 'NEW_REF' && r.billNo === billNo)) {
          throw new AppError(`Line ${i + 1}: ${led.name} already has a bill ${billNo}`, 400, 'BILL_EXISTS')
        }
      }
      refs.push({ kind: b.kind, billNo, billDate: date, dueDate: b.dueDate ? dayValue(b.dueDate) : null, amount: r2(sign * b.amount) })
    }
    refsByLine.push(refs)
  }

  // ── Written ──
  const voucherNo = existing?.voucherNo ?? (await nextDocumentNumber(tx, VOUCHER_SERIES[input.kind], date))
  const amount = r2(dr.reduce((t, l) => t + l.amount, 0))
  const header = {
    date,
    financialYear,
    narration: input.narration || null,
    amount,
    mode: input.mode ?? null,
    referenceNo: input.referenceNo || null,
    chequeNo: input.chequeNo || null,
    chequeDate: input.chequeDate ? dayValue(input.chequeDate) : null,
  }
  let id: string
  if (existing) {
    await tx.voucherLine.deleteMany({ where: { voucherId: existing.id } })
    await tx.voucher.update({ where: { id: existing.id }, data: { ...header, updatedById: userId } })
    id = existing.id
  } else {
    const made = await tx.voucher.create({ data: { ...header, kind: input.kind, voucherNo, createdById: userId }, select: { id: true } })
    id = made.id
  }
  for (const [i, l] of input.lines.entries()) {
    await tx.voucherLine.create({
      data: {
        voucherId: id,
        ledgerId: l.ledgerId,
        debit: l.side === 'DR' ? r2(l.amount) : 0,
        credit: l.side === 'CR' ? r2(l.amount) : 0,
        costCentreId: l.costCentreId || null,
        narration: l.narration || null,
        sortOrder: i,
        billRefs: {
          create: refsByLine[i].map((r) => ({
            ledgerId: l.ledgerId,
            kind: r.kind,
            // An advance or an amount on account is known by the voucher that carried it.
            billNo: r.billNo ?? voucherNo,
            billDate: r.billDate,
            dueDate: r.dueDate,
            amount: r.amount,
          })),
        },
      },
    })
  }
  return { id, voucherNo }
}

/**
 * Cancels a voucher typed here, keeping its number and lines. Refused when a
 * bill it raised has been settled since: that settlement would be left
 * pointing at nothing.
 */
export async function cancelVoucher(tx: Tx, id: string, reason: string, userId: string) {
  const v = await tx.voucher.findUnique({
    where: { id },
    select: { id: true, voucherNo: true, date: true, status: true, sourceType: true, lines: { select: { billRefs: { select: { ledgerId: true, billNo: true, kind: true } } } } },
  })
  if (!v) throw new AppError('Voucher not found', 404, 'NOT_FOUND')
  if (v.status === 'CANCELLED') throw new AppError(`${v.voucherNo} is already cancelled`, 409, 'ALREADY_CANCELLED')
  if (v.sourceType) throw new AppError(`${v.voucherNo} was written by its document. Cancel the document, and its voucher goes with it.`, 409, 'FROM_DOCUMENT')
  const s = await booksSettings(tx)
  if (s.lockedUpTo && istDay(v.date) <= s.lockedUpTo) {
    throw new AppError(`The books are closed up to ${s.lockedUpTo}; ${v.voucherNo} cannot be cancelled.`, 409, 'PERIOD_LOCKED')
  }
  const raised = v.lines.flatMap((l) => l.billRefs).filter((r) => r.kind !== 'AGAINST_REF')
  for (const r of raised) {
    const settled = await tx.billRef.findFirst({
      where: { ledgerId: r.ledgerId, billNo: r.billNo, kind: 'AGAINST_REF', line: { voucher: { status: 'POSTED', id: { not: v.id } } } },
      select: { line: { select: { voucher: { select: { voucherNo: true } } } } },
    })
    if (settled) {
      throw new AppError(`Bill ${r.billNo} raised by ${v.voucherNo} has been settled by ${settled.line?.voucher.voucherNo}. Cancel that first.`, 409, 'BILL_SETTLED')
    }
  }
  await tx.voucher.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: userId, cancelReason: reason } })
  return v.voucherNo
}
