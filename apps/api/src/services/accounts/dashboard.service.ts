import type { Prisma } from '@prisma/client'
import { booksSettings, fyStartOf, ledgerFigures, r2 } from './books.service'
import { outstanding } from './outstanding.service'
import { profitAndLoss } from './finalAccounts.service'
import { gstr3b } from './gst.service'
import { tdsDeducted } from './tdsBooks.service'
import { pendingDocuments } from './posting.service'

/**
 * The accounts at a glance, on one day: money in hand and at the bank, what
 * customers owe and what is owed to suppliers, GST and TDS to pay and by
 * when, the year's sales and profit, month by month — and the things that
 * want doing: documents not yet in the books, bank entries never reconciled,
 * a month not yet closed, opening balances that do not agree.
 *
 * Every figure comes from the same services the screens behind it use, so a
 * tile and the page it opens always show the same number.
 */

type Tx = Prisma.TransactionClient

/** Every group at or under these standard groups. */
async function under(tx: Tx, keys: string[]) {
  const groups = await tx.ledgerGroup.findMany({ select: { id: true, parentId: true, systemKey: true } })
  const ids = new Set(groups.filter((g) => g.systemKey && keys.includes(g.systemKey)).map((g) => g.id))
  for (let grew = true; grew; ) {
    grew = false
    for (const g of groups) if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) ((ids.add(g.id)), (grew = true))
  }
  return ids
}

const monthEnd = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10)
const prevMonth = (m: string) => {
  const y = Number(m.slice(0, 4))
  const mo = Number(m.slice(5, 7))
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`
}
const nextMonth = (m: string) => {
  const y = Number(m.slice(0, 4))
  const mo = Number(m.slice(5, 7))
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
}

export async function accountsDashboard(tx: Tx, today: string) {
  const s = await booksSettings(tx)
  if (!s.booksStart) return { booksStart: null as string | null }
  const fyStart = fyStartOf(today, s.fyStartMonth)

  const [cashGroups, bankGroups, odGroups, salesGroups, purchaseGroups] = await Promise.all([
    under(tx, ['CASH_IN_HAND']),
    under(tx, ['BANK_ACCOUNTS']),
    under(tx, ['BANK_OD']),
    under(tx, ['SALES_ACCOUNTS']),
    under(tx, ['PURCHASE_ACCOUNTS']),
  ])
  const figures = await ledgerFigures(tx, { from: fyStart, to: today }, s)
  const sumIn = (groups: Set<string>) => r2(figures.filter((f) => groups.has(f.groupId)).reduce((t, f) => t + f.closing, 0))
  const banks = figures.filter((f) => bankGroups.has(f.groupId) || odGroups.has(f.groupId)).filter((f) => f.closing !== 0 || f.dr !== 0 || f.cr !== 0)

  const [rec, pay, pl, tds, pending] = await Promise.all([
    outstanding(tx, 'receivable', today),
    outstanding(tx, 'payable', today),
    profitAndLoss(tx, { from: fyStart, to: today }, s),
    tdsDeducted(tx, fyStart, today, today),
    pendingDocuments(tx),
  ])

  // GST: last month's return is due by the 20th; after that, this month's so far.
  const thisMonth = today.slice(0, 7)
  const lastMonth = prevMonth(thisMonth)
  const gstMonth = Number(today.slice(8, 10)) <= 20 ? lastMonth : thisMonth
  let gst: { month: string; due: string; cash: number; tax: number; credit: number } | null = null
  try {
    const g = await gstr3b(tx, `${gstMonth}-01`, gstMonth === thisMonth ? today : monthEnd(gstMonth))
    const cash = r2(g.setOff.cash.igst + g.setOff.cash.cgst + g.setOff.cash.sgst + g.rcmCash.igst + g.rcmCash.cgst + g.rcmCash.sgst)
    gst = {
      month: gstMonth,
      due: `${nextMonth(gstMonth)}-20`,
      cash,
      tax: r2(g.outward.igst + g.outward.cgst + g.outward.sgst),
      credit: r2(g.itc.net.igst + g.itc.net.cgst + g.itc.net.sgst),
    }
  } catch {
    // No GSTIN on the company yet: the tile says so rather than the page failing.
  }

  // Month by month, this financial year — from the month the books start, if that is later.
  const ids = (groups: Set<string>) => figures.filter((f) => groups.has(f.groupId)).map((f) => f.id)
  const money = [...cashGroups, ...bankGroups, ...odGroups]
  const moneyIds = figures.filter((f) => money.includes(f.groupId)).map((f) => f.id)
  const rows = await tx.$queryRawUnsafe<Array<{ m: string; sales: number; purchases: number; money_in: number; money_out: number }>>(
    `SELECT to_char(v.date + interval '330 minutes', 'YYYY-MM') AS m,
       COALESCE(SUM(CASE WHEN l."ledgerId" = ANY($1::text[]) THEN l.credit - l.debit END), 0)::float8 AS sales,
       COALESCE(SUM(CASE WHEN l."ledgerId" = ANY($2::text[]) THEN l.debit - l.credit END), 0)::float8 AS purchases,
       COALESCE(SUM(CASE WHEN l."ledgerId" = ANY($3::text[]) AND v.kind <> 'CONTRA' THEN l.debit END), 0)::float8 AS money_in,
       COALESCE(SUM(CASE WHEN l."ledgerId" = ANY($3::text[]) AND v.kind <> 'CONTRA' THEN l.credit END), 0)::float8 AS money_out
     FROM ld_erp.acc_voucher_lines l JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
     WHERE v.status = 'POSTED' AND v.date >= $4 AND v.date <= $5
     GROUP BY 1 ORDER BY 1`,
    ids(salesGroups),
    ids(purchaseGroups),
    moneyIds,
    new Date(`${fyStart}T00:00:00+05:30`),
    new Date(`${today}T23:59:59.999+05:30`),
  )
  const byMonth = new Map(rows.map((r) => [r.m, r]))
  const months: Array<{ month: string; sales: number; purchases: number; moneyIn: number; moneyOut: number }> = []
  for (let m = (s.booksStart > fyStart ? s.booksStart : fyStart).slice(0, 7); m <= thisMonth; m = nextMonth(m)) {
    const r = byMonth.get(m)
    months.push({ month: m, sales: r2(r?.sales ?? 0), purchases: r2(r?.purchases ?? 0), moneyIn: r2(r?.money_in ?? 0), moneyOut: r2(r?.money_out ?? 0) })
  }

  // What wants doing.
  const bankIds = figures.filter((f) => bankGroups.has(f.groupId) || odGroups.has(f.groupId)).map((f) => f.id)
  const monthAgo = new Date(new Date(`${today}T00:00:00+05:30`).getTime() - 30 * 86_400_000)
  const [unreconciled, opening] = await Promise.all([
    tx.voucherLine.count({ where: { ledgerId: { in: bankIds }, bankDate: null, voucher: { status: 'POSTED', date: { lt: monthAgo } } } }),
    tx.ledger.aggregate({ _sum: { openingBalance: true } }),
  ])
  const openingDifference = r2(Number(opening._sum.openingBalance ?? 0))
  const lastMonthEnd = monthEnd(lastMonth)
  const notClosed = lastMonthEnd >= s.booksStart && (!s.lockedUpTo || s.lockedUpTo < lastMonthEnd) ? lastMonth : null
  const noPan = new Set(tds.deducted.filter((d) => !d.pan && d.party !== '—').map((d) => d.party))

  const bills = (p: typeof pay) => p.parties.flatMap((x) => x.bills.filter((b) => b.kind === 'bill').map((b) => ({ ...b, party: x.name })))
  const payDue7 = r2(bills(pay).filter((b) => b.days > -7 && b.days <= 0).reduce((t, b) => t + b.amount, 0))
  const top = (p: typeof rec) =>
    [...p.parties]
      .filter((x) => x.net > 0)
      .sort((a, b) => b.net - a.net)
      .slice(0, 5)
      .map((x) => ({ ledgerId: x.ledgerId, name: x.name, net: x.net, overdue: x.overdue }))

  return {
    booksStart: s.booksStart,
    lockedUpTo: s.lockedUpTo,
    today,
    fyStart,
    money: {
      cash: sumIn(cashGroups),
      bank: sumIn(bankGroups),
      overdraft: sumIn(odGroups),
      banks: banks.map((b) => ({ id: b.id, name: b.name, balance: b.closing })),
    },
    receivable: { ...rec.summary, top: top(rec) },
    payable: { ...pay.summary, dueIn7: payDue7, top: top(pay) },
    year: { sales: r2(pl.blocks.find((b) => b.key === 'SALES_ACCOUNTS')?.total ?? 0), purchases: r2(pl.blocks.find((b) => b.key === 'PURCHASE_ACCOUNTS')?.total ?? 0), grossProfit: pl.grossProfit, netProfit: pl.netProfit, closingStock: pl.closingStock.value },
    gst,
    tds: { owing: tds.totals.owing, late: tds.totals.late },
    months,
    attention: {
      pending: pending.pending.length,
      unreconciled,
      openingDifference,
      notClosed,
      noPan: [...noPan],
    },
  }
}
