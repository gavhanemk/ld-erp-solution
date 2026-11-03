import type { LedgerNature, Prisma, VoucherKind } from '@prisma/client'
import { AppError } from '../../middleware/errorHandler'

/**
 * Reading the books: what a ledger stood at on a day, what moved through it
 * in a period, and the trial balance.
 *
 * Every figure is worked out from the vouchers each time it is asked for;
 * nothing keeps a running balance that could drift from them. Cancelled
 * vouchers count for nothing.
 *
 * Days are Indian days. A voucher is stored at midnight UTC of its own date,
 * which falls inside that day in India, and a period runs from the first
 * moment of its first day in India to the last moment of its last.
 *
 * Balances are signed: debit positive, credit negative. Screens turn the
 * sign into "Dr" and "Cr".
 */

type Tx = Prisma.TransactionClient

export const r2 = (n: number) => Math.round(n * 100) / 100

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** Today, as a day in India. */
export function todayIst(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
}

/** The day in India a moment falls on. */
export function istDay(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10)
}

/** How a voucher's date is stored: midnight UTC of that day. */
export const dayValue = (ymd: string) => new Date(`${ymd}T00:00:00Z`)
const dayStart = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`)
const dayEnd = (ymd: string) => new Date(`${ymd}T23:59:59.999+05:30`)

/** The first day of the financial year a day falls in. */
export function fyStartOf(ymd: string, startMonth = 4): string {
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(5, 7))
  const year = m >= startMonth ? y : y - 1
  return `${year}-${String(startMonth).padStart(2, '0')}-01`
}

/** The day before. */
export function dayBefore(ymd: string): string {
  return new Date(dayValue(ymd).getTime() - 86_400_000).toISOString().slice(0, 10)
}

export interface BooksSettings {
  /** The day the books start; nothing is entered before it. */
  booksStart: string | null
  /** Closed up to and including this day. */
  lockedUpTo: string | null
  fyStartMonth: number
}

export async function booksSettings(tx: Tx): Promise<BooksSettings> {
  const c = await tx.company.findFirst({ select: { booksStartDate: true, booksLockedUpTo: true, fyStartMonth: true } })
  return {
    booksStart: c?.booksStartDate ? istDay(c.booksStartDate) : null,
    lockedUpTo: c?.booksLockedUpTo ? istDay(c.booksLockedUpTo) : null,
    fyStartMonth: c?.fyStartMonth ?? 4,
  }
}

/**
 * The bank dates a voucher's lines carry, kept by ledger and amount, so a
 * voucher rewritten without changing its bank line stays reconciled. A
 * changed amount has to be reconciled again.
 */
export async function bankDatesOf(tx: Tx, voucherId: string): Promise<Map<string, Date>> {
  const lines = await tx.voucherLine.findMany({ where: { voucherId, bankDate: { not: null } }, select: { ledgerId: true, debit: true, credit: true, bankDate: true } })
  return new Map(lines.map((l) => [bankKey(l.ledgerId, Number(l.debit) - Number(l.credit)), l.bankDate!]))
}
export const bankKey = (ledgerId: string, signed: number) => `${ledgerId}|${r2(signed).toFixed(2)}`

/** A period from the query string: this financial year to today unless asked otherwise. */
export function periodFrom(query: Record<string, unknown>, s: BooksSettings): { from: string; to: string } {
  const pick = (v: unknown) => (typeof v === 'string' && YMD.test(v) ? v : undefined)
  const to = pick(query.to) ?? todayIst()
  let from = pick(query.from) ?? fyStartOf(to, s.fyStartMonth)
  if (s.booksStart && from < s.booksStart && !pick(query.from)) from = s.booksStart
  if (from > to) throw new AppError('The start date is after the end date', 400, 'BAD_PERIOD')
  return { from, to }
}

const PL: LedgerNature[] = ['INCOME', 'EXPENSE']
const isPl = (n: LedgerNature) => PL.includes(n)

interface Movement {
  /** Every posted line before the period. */
  beforeAll: number
  /** Posted lines from the start of the period's financial year to the day before it. */
  beforeFy: number
  dr: number
  cr: number
}

async function movements(tx: Tx, from: string, to: string, fyStart: string, ledgerId?: string): Promise<Map<string, Movement>> {
  const one = ledgerId ? `AND l."ledgerId" = $4` : ''
  const params: unknown[] = [dayStart(from), dayEnd(to), dayStart(fyStart)]
  if (ledgerId) params.push(ledgerId)
  const rows = await tx.$queryRawUnsafe<Array<{ id: string; before_all: number; before_fy: number; dr: number; cr: number }>>(
    `SELECT l."ledgerId" AS id,
       COALESCE(SUM(CASE WHEN v.date < $1 THEN l.debit - l.credit END), 0)::float8 AS before_all,
       COALESCE(SUM(CASE WHEN v.date >= $3 AND v.date < $1 THEN l.debit - l.credit END), 0)::float8 AS before_fy,
       COALESCE(SUM(CASE WHEN v.date >= $1 THEN l.debit END), 0)::float8 AS dr,
       COALESCE(SUM(CASE WHEN v.date >= $1 THEN l.credit END), 0)::float8 AS cr
     FROM ld_erp.acc_voucher_lines l
     JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
     WHERE v.status = 'POSTED' AND v.date <= $2 ${one}
     GROUP BY l."ledgerId"`,
    ...params,
  )
  return new Map(rows.map((r) => [r.id, { beforeAll: r.before_all, beforeFy: r.before_fy, dr: r.dr, cr: r.cr }]))
}

export interface LedgerFigures {
  id: string
  name: string
  groupId: string
  nature: LedgerNature
  systemKey: string | null
  opening: number
  dr: number
  cr: number
  closing: number
}

/**
 * Every ledger's opening, movement and closing for a period.
 *
 * A balance-sheet ledger carries everything before the period. An income or
 * expense ledger starts each financial year at nothing: last year's figures
 * are closed into the Profit & Loss A/c, whose opening here is its own
 * opening plus the profit of every year before this one. Nobody posts a
 * closing entry; the carry-forward is arithmetic.
 */
export async function ledgerFigures(tx: Tx, period: { from: string; to: string }, s: BooksSettings, onlyLedgerId?: string): Promise<LedgerFigures[]> {
  const fyStart = fyStartOf(period.from, s.fyStartMonth)
  // Opening balances are as at the day the books start; one that started in
  // an earlier year has already been carried through to this one.
  const openedThisYear = !s.booksStart || s.booksStart >= fyStart
  const [ledgers, moved] = await Promise.all([
    tx.ledger.findMany({
      where: onlyLedgerId ? { id: onlyLedgerId } : undefined,
      select: { id: true, name: true, groupId: true, systemKey: true, openingBalance: true, group: { select: { nature: true } } },
      orderBy: { name: 'asc' },
    }),
    movements(tx, period.from, period.to, fyStart, undefined),
  ])

  // The profit of the years before this one, as a signed balance (a profit is
  // a credit). Only the Profit & Loss A/c needs it.
  let earlier = 0
  if (ledgers.some((l) => l.systemKey === 'PROFIT_LOSS')) {
    const all = onlyLedgerId
      ? await tx.ledger.findMany({ select: { id: true, openingBalance: true, group: { select: { nature: true } } } })
      : ledgers
    for (const l of all) {
      if (!isPl(l.group.nature)) continue
      const m = moved.get(l.id)
      earlier += (m ? m.beforeAll - m.beforeFy : 0) + (openedThisYear ? 0 : Number(l.openingBalance))
    }
  }

  return ledgers.map((l) => {
    const m = moved.get(l.id) ?? { beforeAll: 0, beforeFy: 0, dr: 0, cr: 0 }
    const own = Number(l.openingBalance)
    let opening = isPl(l.group.nature) ? (openedThisYear ? own : 0) + m.beforeFy : own + m.beforeAll
    if (l.systemKey === 'PROFIT_LOSS') opening += earlier
    opening = r2(opening)
    return {
      id: l.id,
      name: l.name,
      groupId: l.groupId,
      nature: l.group.nature,
      systemKey: l.systemKey,
      opening,
      dr: r2(m.dr),
      cr: r2(m.cr),
      closing: r2(opening + m.dr - m.cr),
    }
  })
}

export interface GroupFigures {
  id: string
  name: string
  parentId: string | null
  nature: LedgerNature
  affectsGrossProfit: boolean
  sortOrder: number
  opening: number
  dr: number
  cr: number
  closing: number
  ledgerCount: number
}

/**
 * The trial balance: every group with the sum of everything under it, and
 * every ledger. The two sides agree unless the opening balances do not; the
 * gap is shown on its own line, as SAB and Tally show it, rather than hidden.
 */
export async function trialBalance(tx: Tx, period: { from: string; to: string }, s: BooksSettings) {
  const [groups, ledgers] = await Promise.all([
    tx.ledgerGroup.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    ledgerFigures(tx, period, s),
  ])
  const parentOf = new Map(groups.map((g) => [g.id, g.parentId]))
  const sums = new Map<string, { opening: number; dr: number; cr: number; closing: number; ledgerCount: number }>(
    groups.map((g) => [g.id, { opening: 0, dr: 0, cr: 0, closing: 0, ledgerCount: 0 }]),
  )
  for (const l of ledgers) {
    // Up the tree from the ledger's own group to the top.
    for (let g: string | null | undefined = l.groupId; g; g = parentOf.get(g)) {
      const t = sums.get(g)
      if (!t) break
      t.opening += l.opening
      t.dr += l.dr
      t.cr += l.cr
      t.closing += l.closing
      t.ledgerCount += 1
    }
  }
  const groupRows: GroupFigures[] = groups.map((g) => {
    const t = sums.get(g.id)!
    return {
      id: g.id,
      name: g.name,
      parentId: g.parentId,
      nature: g.nature,
      affectsGrossProfit: g.affectsGrossProfit,
      sortOrder: g.sortOrder,
      opening: r2(t.opening),
      dr: r2(t.dr),
      cr: r2(t.cr),
      closing: r2(t.closing),
      ledgerCount: t.ledgerCount,
    }
  })
  const totals = ledgers.reduce(
    (t, l) => ({
      openingDr: t.openingDr + Math.max(l.opening, 0),
      openingCr: t.openingCr + Math.max(-l.opening, 0),
      dr: t.dr + l.dr,
      cr: t.cr + l.cr,
      closingDr: t.closingDr + Math.max(l.closing, 0),
      closingCr: t.closingCr + Math.max(-l.closing, 0),
    }),
    { openingDr: 0, openingCr: 0, dr: 0, cr: 0, closingDr: 0, closingCr: 0 },
  )
  for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] = r2(totals[k])
  // What the opening balances are out by: debit positive. It carries to the closing unchanged.
  const openingDifference = r2(totals.openingDr - totals.openingCr)
  return { period, groups: groupRows, ledgers, totals, openingDifference }
}

export const KIND_LABEL: Record<VoucherKind, string> = {
  PAYMENT: 'Payment',
  RECEIPT: 'Receipt',
  CONTRA: 'Contra',
  JOURNAL: 'Journal',
  SALES: 'Sales',
  PURCHASE: 'Purchase',
  CREDIT_NOTE: 'Credit Note',
  DEBIT_NOTE: 'Debit Note',
}

/**
 * One ledger, line by line, for a period: the opening, every posted voucher
 * that touched it with the ledgers on the other side, a running balance, and
 * the closing.
 */
export async function ledgerStatement(tx: Tx, ledgerId: string, period: { from: string; to: string }, s: BooksSettings) {
  const [figures] = await ledgerFigures(tx, period, s, ledgerId)
  if (!figures) throw new AppError('Ledger not found', 404, 'NOT_FOUND')
  const ledger = await tx.ledger.findUnique({
    where: { id: ledgerId },
    select: {
      id: true,
      name: true,
      billWise: true,
      partyType: true,
      systemKey: true,
      group: { select: { id: true, name: true, nature: true } },
    },
  })
  const lines = await tx.voucherLine.findMany({
    where: { ledgerId, voucher: { status: 'POSTED', date: { gte: dayStart(period.from), lte: dayEnd(period.to) } } },
    orderBy: [{ voucher: { date: 'asc' } }, { voucher: { createdAt: 'asc' } }, { sortOrder: 'asc' }],
    select: {
      id: true,
      debit: true,
      credit: true,
      narration: true,
      costCentre: { select: { name: true } },
      billRefs: { select: { kind: true, billNo: true, amount: true } },
      voucher: {
        select: {
          id: true,
          kind: true,
          voucherNo: true,
          date: true,
          narration: true,
          sourceType: true,
          chequeNo: true,
          referenceNo: true,
          lines: { select: { id: true, debit: true, credit: true, ledger: { select: { name: true } } }, orderBy: { sortOrder: 'asc' } },
        },
      },
    },
  })
  let balance = figures.opening
  const rows = lines.map((l) => {
    const debit = Number(l.debit)
    const credit = Number(l.credit)
    balance = r2(balance + debit - credit)
    // The ledgers on the other side of this line, as the "Particulars" column reads them.
    const others = l.voucher.lines.filter((o) => o.id !== l.id && (debit > 0 ? Number(o.credit) > 0 : Number(o.debit) > 0))
    const particulars = others.length === 0 ? '—' : others.length === 1 ? others[0].ledger.name : `${others[0].ledger.name} + ${others.length - 1} more`
    return {
      lineId: l.id,
      voucherId: l.voucher.id,
      date: istDay(l.voucher.date),
      kind: l.voucher.kind,
      kindLabel: KIND_LABEL[l.voucher.kind],
      voucherNo: l.voucher.voucherNo,
      fromModule: !!l.voucher.sourceType,
      particulars,
      narration: l.narration ?? l.voucher.narration,
      chequeNo: l.voucher.chequeNo,
      referenceNo: l.voucher.referenceNo,
      costCentre: l.costCentre?.name ?? null,
      bills: l.billRefs.map((b) => ({ kind: b.kind, billNo: b.billNo, amount: Number(b.amount) })),
      debit,
      credit,
      balance,
    }
  })
  return {
    ledger,
    period,
    opening: figures.opening,
    totals: { dr: figures.dr, cr: figures.cr },
    closing: figures.closing,
    rows,
  }
}

/**
 * A party's bills still open on a day: each bill's number, date, due date and
 * what is left of it, from the opening bills and every posted voucher.
 * `exceptVoucherId` leaves one voucher out — the one being edited, whose own
 * settlements are about to be written again.
 */
export async function openBills(tx: Tx, ledgerId: string, exceptVoucherId?: string) {
  const refs = await tx.billRef.findMany({
    where: {
      ledgerId,
      OR: [{ lineId: null }, { line: { voucher: { status: 'POSTED', ...(exceptVoucherId ? { id: { not: exceptVoucherId } } : {}) } } }],
    },
    select: { kind: true, billNo: true, billDate: true, dueDate: true, amount: true, line: { select: { voucher: { select: { sourceType: true } } } } },
  })
  type Bill = { billNo: string; billDate: Date; dueDate: Date | null; raised: boolean; pending: number; kind: string | null; raisedBy: string | null }
  const bills = new Map<string, Bill>()
  for (const r of refs) {
    const b = bills.get(r.billNo) ?? { billNo: r.billNo, billDate: r.billDate, dueDate: r.dueDate, raised: false, pending: 0, kind: null, raisedBy: null }
    b.pending = r2(b.pending + Number(r.amount))
    if (r.kind !== 'AGAINST_REF') {
      b.raised = true
      b.billDate = r.billDate
      b.dueDate = r.dueDate
      b.kind = r.kind
      b.raisedBy = r.line?.voucher.sourceType ?? null
    }
    bills.set(r.billNo, b)
  }
  return [...bills.values()]
    .filter((b) => Math.abs(b.pending) >= 0.005)
    .sort((a, b) => a.billDate.getTime() - b.billDate.getTime() || a.billNo.localeCompare(b.billNo))
    .map((b) => ({
      billNo: b.billNo,
      billDate: istDay(b.billDate),
      dueDate: b.dueDate ? istDay(b.dueDate) : null,
      pending: b.pending,
      raised: b.raised,
      /** A customer's invoice or a supplier's bill, settled only from Sales or Purchase. */
      fromDocument: b.kind === 'NEW_REF' && !!b.raisedBy && b.raisedBy !== 'BROKERAGE',
      raisedBy: b.raisedBy,
    }))
}
