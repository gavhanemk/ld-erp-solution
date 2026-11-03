// Accounts, phase 6: the dashboard, checked against the screens behind it.
//
//   - before the books start it says so and nothing else;
//   - cash and bank equal the cash and bank ledgers' closing balances;
//   - what customers owe and what is owed to suppliers equal Outstanding,
//     and the top five are the five largest;
//   - the year's sales and purchases equal Profit & Loss, and the months add
//     up to them;
//   - money in less money out, month by month, equals the change in cash and
//     bank since the year began;
//   - GST is last month's return until the 20th, due on the 20th after;
//   - TDS owed equals the TDS register; documents not in the books equal
//     the Day Book's list; the opening difference equals the trial balance's;
//   - a bank entry over a month old with no bank date is flagged, and stops
//     being flagged once it has one; last month shows as not closed until it
//     is.
//
// Runs inside one transaction that always throws: nothing is kept. Run it from
// apps/api, so the database settings load:
//
//   cd apps/api
//   npx tsx ../../tools/check-accounts-phase6.ts
import { prisma } from '../packages/database/src/index'
import type { Prisma } from '@prisma/client'
import { ensureChart } from '../apps/api/src/services/accounts/chart.service'
import { booksSettings, dayValue, fyStartOf, ledgerStatement, todayIst, trialBalance } from '../apps/api/src/services/accounts/books.service'
import { pendingDocuments, postDocument, type SourceType } from '../apps/api/src/services/accounts/posting.service'
import { outstanding } from '../apps/api/src/services/accounts/outstanding.service'
import { profitAndLoss } from '../apps/api/src/services/accounts/finalAccounts.service'
import { tdsDeducted } from '../apps/api/src/services/accounts/tdsBooks.service'
import { setBankDates } from '../apps/api/src/services/accounts/bankReco.service'
import { voucherSchema, writeVoucher } from '../apps/api/src/services/accounts/voucher.service'
import { accountsDashboard } from '../apps/api/src/services/accounts/dashboard.service'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const r2 = (n: number) => Math.round(n * 100) / 100
const near = (a: number, b: number) => Math.abs(a - b) < 0.05
const sum = (xs: number[]) => r2(xs.reduce((t, x) => t + x, 0))
const daysAgo = (today: string, n: number) => new Date(new Date(`${today}T00:00:00Z`).getTime() - n * 86_400_000).toISOString().slice(0, 10)
type Dash = Exclude<Awaited<ReturnType<typeof accountsDashboard>>, { booksStart: null }> & { money: { cash: number } }

async function main() {
  await ensureChart(true)
  try {
    await prisma.$transaction(
      async (tx) => {
        await run(tx)
        throw ROLLBACK
      },
      { timeout: 600_000, maxWait: 20_000 },
    )
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

/** Ledgers at or under these standard groups. */
async function ledgersUnder(tx: Prisma.TransactionClient, keys: string[]) {
  const groups = await tx.ledgerGroup.findMany({ select: { id: true, parentId: true, systemKey: true } })
  const ids = new Set(groups.filter((g) => g.systemKey && keys.includes(g.systemKey)).map((g) => g.id))
  for (let grew = true; grew; ) {
    grew = false
    for (const g of groups) if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) ((ids.add(g.id)), (grew = true))
  }
  return (await tx.ledger.findMany({ where: { groupId: { in: [...ids] } }, select: { id: true } })).map((l) => l.id)
}

async function run(tx: Prisma.TransactionClient) {
  const today = todayIst()
  const company = await tx.company.findFirstOrThrow({ select: { id: true } })

  // ── Before the books start ───────────────────────────────────
  await tx.company.update({ where: { id: company.id }, data: { booksStartDate: null, booksLockedUpTo: null } })
  const before = await accountsDashboard(tx, today)
  check('before the books start, the dashboard only says so', before.booksStart === null && Object.keys(before).length === 1)

  // ── The books, with every document in them ───────────────────
  await tx.company.update({ where: { id: company.id }, data: { booksStartDate: dayValue('2024-04-01') } })
  await tx.voucher.deleteMany({ where: { sourceType: { not: null } } })
  const docs: Array<[SourceType, string]> = [
    ...(await tx.salesInvoice.findMany({ select: { id: true } })).map((d) => ['SALES_INVOICE', d.id] as [SourceType, string]),
    ...(await tx.purchaseInvoice.findMany({ select: { id: true } })).map((d) => ['PURCHASE_BILL', d.id] as [SourceType, string]),
    ...(await tx.creditNote.findMany({ select: { id: true } })).map((d) => ['CREDIT_NOTE', d.id] as [SourceType, string]),
    ...(await tx.purchaseNote.findMany({ select: { id: true } })).map((d) => ['PURCHASE_NOTE', d.id] as [SourceType, string]),
    ...(await tx.paymentReceipt.findMany({ select: { id: true } })).map((d) => ['SALES_RECEIPT', d.id] as [SourceType, string]),
    ...(await tx.supplierPayment.findMany({ select: { id: true } })).map((d) => ['SUPPLIER_PAYMENT', d.id] as [SourceType, string]),
  ]
  for (const [t, id] of docs) await postDocument(tx, t, id)

  const s = await booksSettings(tx)
  const fyStart = fyStartOf(today, s.fyStartMonth)
  const d = (await accountsDashboard(tx, today)) as Dash
  check('the dashboard reads the books as on today, for this financial year', d.today === today && d.fyStart === fyStart && d.booksStart === '2024-04-01')

  // ── Cash and bank ────────────────────────────────────────────
  const closingOf = async (ids: string[], period: { from: string; to: string }) => {
    let close = 0
    let open = 0
    for (const id of ids) {
      const st = await ledgerStatement(tx, id, period, s)
      close += st.closing
      open += st.opening
    }
    return { close: r2(close), open: r2(open) }
  }
  const [cashIds, bankIds, odIds] = await Promise.all([ledgersUnder(tx, ['CASH_IN_HAND']), ledgersUnder(tx, ['BANK_ACCOUNTS']), ledgersUnder(tx, ['BANK_OD'])])
  const year = { from: fyStart, to: today }
  const [cash, bank, od] = await Promise.all([closingOf(cashIds, year), closingOf(bankIds, year), closingOf(odIds, year)])
  check('cash in hand equals the cash ledgers', near(d.money.cash, cash.close), `${d.money.cash} / ${cash.close}`)
  check('at the bank equals the bank ledgers', near(d.money.bank, bank.close), `${d.money.bank} / ${bank.close}`)
  check('overdraft equals the overdraft ledgers', near(d.money.overdraft, od.close), `${d.money.overdraft} / ${od.close}`)
  check('each bank account listed carries its own ledger balance', d.money.banks.every((b) => [...bankIds, ...odIds].includes(b.id)) && near(sum(d.money.banks.map((b) => b.balance)), r2(bank.close + od.close)))

  // ── Owed both ways ───────────────────────────────────────────
  const [rec, pay] = await Promise.all([outstanding(tx, 'receivable', today), outstanding(tx, 'payable', today)])
  check('customers owe what Outstanding says', near(d.receivable.net, rec.summary.net) && near(d.receivable.overdue, rec.summary.overdue), `${d.receivable.net} / ${rec.summary.net}`)
  check('suppliers are owed what Outstanding says', near(d.payable.net, pay.summary.net) && near(d.payable.overdue, pay.summary.overdue), `${d.payable.net} / ${pay.summary.net}`)
  const topFive = (p: typeof rec) =>
    [...p.parties]
      .filter((x) => x.net > 0)
      .sort((a, b) => b.net - a.net)
      .slice(0, 5)
      .map((x) => x.ledgerId)
  check('the top five debtors are the five who owe the most', JSON.stringify(d.receivable.top.map((x) => x.ledgerId)) === JSON.stringify(topFive(rec)), `${d.receivable.top.length} listed`)
  check('the top five creditors are the five owed the most', JSON.stringify(d.payable.top.map((x) => x.ledgerId)) === JSON.stringify(topFive(pay)), `${d.payable.top.length} listed`)
  const dueSoon = sum(pay.parties.flatMap((p) => p.bills.filter((b) => b.kind === 'bill' && b.days > -7 && b.days <= 0).map((b) => b.amount)))
  check('falling due this week counts supplier bills due in the next seven days', near(d.payable.dueIn7, dueSoon), `${d.payable.dueIn7}`)

  // ── The year ─────────────────────────────────────────────────
  const pl = await profitAndLoss(tx, year, s)
  check('sales and profit equal Profit & Loss', near(d.year.netProfit, pl.netProfit) && near(d.year.grossProfit, pl.grossProfit) && near(d.year.closingStock, pl.closingStock.value))
  check('the months run from the year start to this month', d.months[0]?.month === fyStart.slice(0, 7) && d.months[d.months.length - 1]?.month === today.slice(0, 7))
  await tx.company.update({ where: { id: company.id }, data: { booksStartDate: dayValue(`${today.slice(0, 7)}-01`) } })
  const lateStart = (await accountsDashboard(tx, today)) as Dash
  check('books started this month: the months start there, not at the year start', lateStart.months.length === 1 && lateStart.months[0].month === today.slice(0, 7))
  await tx.company.update({ where: { id: company.id }, data: { booksStartDate: dayValue('2024-04-01') } })
  check("the months' sales add up to the year's", near(sum(d.months.map((m) => m.sales)), d.year.sales), `${sum(d.months.map((m) => m.sales))} / ${d.year.sales}`)
  check("the months' purchases add up to the year's", near(sum(d.months.map((m) => m.purchases)), d.year.purchases), `${sum(d.months.map((m) => m.purchases))} / ${d.year.purchases}`)
  const netFlow = sum(d.months.map((m) => m.moneyIn - m.moneyOut))
  const change = r2(cash.close + bank.close + od.close - (cash.open + bank.open + od.open))
  check('money in less money out equals the change in cash and bank this year', near(netFlow, change), `${netFlow} / ${change}`)

  // ── GST, TDS, and what wants doing ───────────────────────────
  if (d.gst) {
    const dayOfMonth = Number(today.slice(8, 10))
    const thisMonth = today.slice(0, 7)
    const wanted = dayOfMonth <= 20 ? daysAgo(`${thisMonth}-01`, 1).slice(0, 7) : thisMonth
    const [y, m] = wanted.split('-').map(Number)
    const due = m === 12 ? `${y + 1}-01-20` : `${y}-${String(m + 1).padStart(2, '0')}-20`
    check('GST shows last month until the 20th, then this month, due on the 20th after', d.gst.month === wanted && d.gst.due === due, `${d.gst.month} by ${d.gst.due}`)
  } else console.log('(no company GSTIN; the GST tile check is left out)')
  const tds = await tdsDeducted(tx, fyStart, today, today)
  check('TDS owed and late equal the TDS register', near(d.tds.owing, tds.totals.owing) && near(d.tds.late, tds.totals.late))
  const pending = await pendingDocuments(tx)
  check("documents not in the books equal the Day Book's list", d.attention.pending === pending.pending.length, `${d.attention.pending}`)
  const tb = await trialBalance(tx, year, s)
  check("the opening difference equals the trial balance's", near(d.attention.openingDifference, tb.openingDifference), `${d.attention.openingDifference}`)

  // A bank payment 40 days old, never matched to the statement.
  const bankLedger = await tx.ledger.findFirstOrThrow({ where: { partyType: 'BANK', isActive: true }, select: { id: true } })
  const charges = await tx.ledger.findFirstOrThrow({ where: { systemKey: 'BANK_CHARGES' }, select: { id: true } })
  const user = await tx.user.findFirstOrThrow({ where: { status: 'ACTIVE' }, select: { id: true } })
  const old = await writeVoucher(
    tx,
    voucherSchema.parse({ kind: 'PAYMENT', date: daysAgo(today, 40), narration: 'Bank charges, check', lines: [{ ledgerId: charges.id, side: 'DR', amount: 118 }, { ledgerId: bankLedger.id, side: 'CR', amount: 118 }] }),
    user.id,
  )
  const withOld = (await accountsDashboard(tx, today)) as Dash
  check('a bank entry over a month old with no bank date is flagged', withOld.attention.unreconciled === d.attention.unreconciled + 1, `${d.attention.unreconciled} → ${withOld.attention.unreconciled}`)
  const line = await tx.voucherLine.findFirstOrThrow({ where: { voucherId: old.id, ledgerId: bankLedger.id }, select: { id: true } })
  await setBankDates(tx, [{ lineId: line.id, bankDate: daysAgo(today, 38) }])
  const matched = (await accountsDashboard(tx, today)) as Dash
  check('once it has a bank date it is not', matched.attention.unreconciled === d.attention.unreconciled)
  const recent = await writeVoucher(
    tx,
    voucherSchema.parse({ kind: 'PAYMENT', date: daysAgo(today, 5), narration: 'Bank charges, check', lines: [{ ledgerId: charges.id, side: 'DR', amount: 59 }, { ledgerId: bankLedger.id, side: 'CR', amount: 59 }] }),
    user.id,
  )
  check('a bank entry under a month old is not flagged yet', ((await accountsDashboard(tx, today)) as Dash).attention.unreconciled === d.attention.unreconciled, recent.voucherNo)

  // Last month, open and then closed.
  const thisMonth = today.slice(0, 7)
  const lastMonth = daysAgo(`${thisMonth}-01`, 1)
  check('last month shows as not closed', d.attention.notClosed === lastMonth.slice(0, 7), `${d.attention.notClosed}`)
  await tx.company.update({ where: { id: company.id }, data: { booksLockedUpTo: dayValue(lastMonth) } })
  const closed = (await accountsDashboard(tx, today)) as Dash
  check('once it is closed it drops off', closed.attention.notClosed === null && closed.lockedUpTo === lastMonth)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
