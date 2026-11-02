// The books under Accounts, end to end: the chart of accounts made on first
// use, every rule a voucher is held to, bills raised and settled one by one,
// cancelling, altering, the trial balance and a ledger statement agreeing
// with each other, and a closed year's profit carried into the Profit & Loss
// A/c without a closing entry.
//
// The chart itself is made for real (opening Accounts would make it anyway);
// everything after runs inside one transaction that always throws, so no
// voucher, ledger or setting is kept. Run it from apps/api, so the database
// settings load:
//
//   cd apps/api
//   npx tsx ../../tools/check-accounts.ts
import { prisma } from '../packages/database/src/index'
import type { Prisma } from '@prisma/client'
import { ensureChart, STANDARD_GROUPS, SYSTEM_LEDGERS, VOUCHER_SERIES } from '../apps/api/src/services/accounts/chart.service'
import { booksSettings, dayValue, fyStartOf, ledgerStatement, openBills, todayIst, trialBalance } from '../apps/api/src/services/accounts/books.service'
import { cancelVoucher, voucherSchema, writeVoucher, type VoucherInput } from '../apps/api/src/services/accounts/voucher.service'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')

/** Runs `fn` and says whether it was refused with this code. */
async function refused(fn: () => Promise<unknown>, code: string) {
  try {
    await fn()
    return 'not refused'
  } catch (e) {
    const got = (e as { code?: string }).code
    return got === code ? true : `refused with ${got ?? (e as Error).message}`
  }
}
const isTrue = (r: true | string) => r === true
const why = (r: true | string) => (r === true ? '' : r)

async function main() {
  // ── The chart, made on first use ─────────────────────────────
  await ensureChart(true)
  const [groups, ledgers, centres, brands] = await Promise.all([
    prisma.ledgerGroup.findMany({ select: { systemKey: true } }),
    prisma.ledger.findMany({ select: { name: true, systemKey: true, partyType: true, customerId: true, supplierId: true, brokerId: true, contractorId: true, bankAccountId: true } }),
    prisma.costCentre.findMany({ select: { brandId: true } }),
    prisma.brand.count(),
  ])
  const keys = new Set(groups.map((g) => g.systemKey))
  check('every standard group is there', STANDARD_GROUPS.every((g) => keys.has(g.key)), `${groups.length} groups`)
  const lkeys = new Set(ledgers.map((l) => l.systemKey))
  check('every system ledger is there', SYSTEM_LEDGERS.every((l) => lkeys.has(l.key)))
  const [customers, suppliers, brokers, contractors, banks] = await Promise.all([
    prisma.customer.count(),
    prisma.supplier.count(),
    prisma.broker.count(),
    prisma.contractor.count(),
    prisma.bankAccount.count(),
  ])
  check('one ledger per customer', ledgers.filter((l) => l.customerId).length === customers, `${customers} customers`)
  check('one ledger per supplier', ledgers.filter((l) => l.supplierId).length === suppliers, `${suppliers} suppliers`)
  check('one ledger per broker and contractor', ledgers.filter((l) => l.brokerId).length === brokers && ledgers.filter((l) => l.contractorId).length === contractors)
  check('one ledger per bank account', ledgers.filter((l) => l.bankAccountId).length === banks, `${banks} banks`)
  check('ledger names are unique', new Set(ledgers.map((l) => l.name.toLowerCase())).size === ledgers.length)
  check('one cost centre per brand', centres.filter((c) => c.brandId).length === brands, `${brands} brands`)
  const series = await prisma.numberSeries.findMany({ where: { docType: { in: Object.values(VOUCHER_SERIES) } }, select: { docType: true } })
  check('a number series for each voucher type', new Set(series.map((s) => s.docType)).size === 4)
  const count = await prisma.ledger.count()
  await ensureChart(true)
  check('making the chart again adds nothing', (await prisma.ledger.count()) === count)

  // ── Everything else, never kept ──────────────────────────────
  const user = await prisma.user.findFirst({ where: { status: 'ACTIVE' }, select: { id: true } })
  if (!user) throw new Error('Needs an active user')
  try {
    await prisma.$transaction(
      async (tx) => {
        await run(tx, user.id)
        throw ROLLBACK
      },
      { timeout: 120_000 },
    )
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

async function run(tx: Prisma.TransactionClient, userId: string) {
  const today = todayIst()
  const company = await tx.company.findFirstOrThrow({ select: { id: true, fyStartMonth: true } })
  const fyStart = fyStartOf(today, company.fyStartMonth)
  // The books start on the first of last month, or the start of the year if that is later.
  const lastMonth = new Date(dayValue(`${today.slice(0, 8)}01`).getTime() - 86_400_000).toISOString().slice(0, 8) + '01'
  const start = lastMonth < fyStart ? fyStart : lastMonth
  await tx.company.update({ where: { id: company.id }, data: { booksStartDate: dayValue(start), booksLockedUpTo: null } })

  const byKey = async (k: string) => (await tx.ledger.findUniqueOrThrow({ where: { systemKey: k }, select: { id: true } })).id
  const cash = await byKey('CASH')
  const sales = await byKey('SALES')
  const bank = (await tx.ledger.findFirstOrThrow({ where: { partyType: 'BANK', isActive: true }, select: { id: true } })).id
  const customer = await tx.ledger.findFirstOrThrow({ where: { partyType: 'CUSTOMER', isActive: true }, select: { id: true, name: true } })
  const indirect = await tx.ledgerGroup.findUniqueOrThrow({ where: { systemKey: 'INDIRECT_EXPENSES' } })
  const capitalGroup = await tx.ledgerGroup.findUniqueOrThrow({ where: { systemKey: 'CAPITAL' } })
  const rent = await tx.ledger.create({ data: { name: 'Factory Rent (check)', groupId: indirect.id } })
  const capital = await tx.ledger.create({ data: { name: 'Partners Capital (check)', groupId: capitalGroup.id } })
  const brand = await tx.costCentre.findFirstOrThrow({ where: { isActive: true }, select: { id: true } })

  const v = (o: Partial<VoucherInput> & Pick<VoucherInput, 'kind' | 'lines'>): VoucherInput => voucherSchema.parse({ date: today, ...o })
  const write = (o: Partial<VoucherInput> & Pick<VoucherInput, 'kind' | 'lines'>) => writeVoucher(tx, v(o), userId)

  // ── What each type may touch ─────────────────────────────────
  const pay = await write({
    kind: 'PAYMENT',
    mode: 'NEFT',
    referenceNo: 'UTR1',
    lines: [
      { ledgerId: rent.id, side: 'DR', amount: 25_000, costCentreId: brand.id },
      { ledgerId: bank, side: 'CR', amount: 25_000 },
    ],
  })
  check('a payment out of the bank is saved and numbered from PV', pay.voucherNo.startsWith('PV'), pay.voucherNo)
  let r = await refused(() => write({ kind: 'PAYMENT', lines: [{ ledgerId: rent.id, side: 'DR', amount: 10 }, { ledgerId: capital.id, side: 'CR', amount: 10 }] }), 'NEEDS_MONEY')
  check('a payment that credits no cash or bank is refused', isTrue(r), why(r))
  r = await refused(() => write({ kind: 'PAYMENT', lines: [{ ledgerId: cash, side: 'DR', amount: 10 }, { ledgerId: bank, side: 'CR', amount: 10 }] }), 'USE_CONTRA')
  check('cash drawn from the bank as a "payment" is sent to Contra', isTrue(r), why(r))
  r = await refused(() => write({ kind: 'JOURNAL', lines: [{ ledgerId: rent.id, side: 'DR', amount: 10 }, { ledgerId: cash, side: 'CR', amount: 10 }] }), 'JOURNAL_NO_MONEY')
  check('a journal cannot touch cash', isTrue(r), why(r))
  r = await refused(() => write({ kind: 'CONTRA', lines: [{ ledgerId: cash, side: 'DR', amount: 10 }, { ledgerId: rent.id, side: 'CR', amount: 10 }] }), 'CONTRA_MONEY_ONLY')
  check('a contra moves money between cash and bank only', isTrue(r), why(r))
  const contra = await write({ kind: 'CONTRA', lines: [{ ledgerId: cash, side: 'DR', amount: 5_000 }, { ledgerId: bank, side: 'CR', amount: 5_000 }] })
  check('cash withdrawn from the bank is a contra', contra.voucherNo.startsWith('CV'), contra.voucherNo)
  let threw = false
  try {
    v({ kind: 'JOURNAL', lines: [{ ledgerId: rent.id, side: 'DR', amount: 10 }, { ledgerId: capital.id, side: 'CR', amount: 9.99 }] })
  } catch {
    threw = true
  }
  check('debits that do not equal credits are refused', threw)
  r = await refused(() => write({ kind: 'JOURNAL', lines: [{ ledgerId: capital.id, side: 'DR', amount: 10, costCentreId: brand.id }, { ledgerId: rent.id, side: 'CR', amount: 10 }] }), 'COST_CENTRE_PL_ONLY')
  check('a brand on a balance-sheet line is refused', isTrue(r), why(r))

  // ── The days ─────────────────────────────────────────────────
  const dayBeforeStart = new Date(dayValue(start).getTime() - 86_400_000).toISOString().slice(0, 10)
  r = await refused(() => write({ kind: 'CONTRA', date: dayBeforeStart, lines: [{ ledgerId: cash, side: 'DR', amount: 1 }, { ledgerId: bank, side: 'CR', amount: 1 }] }), 'BEFORE_BOOKS')
  check('nothing before the books start', isTrue(r), why(r))
  const tomorrow = new Date(dayValue(today).getTime() + 86_400_000).toISOString().slice(0, 10)
  r = await refused(() => write({ kind: 'CONTRA', date: tomorrow, lines: [{ ledgerId: cash, side: 'DR', amount: 1 }, { ledgerId: bank, side: 'CR', amount: 1 }] }), 'FUTURE_DATE')
  check('nothing dated after today', isTrue(r), why(r))

  // ── Bills, one by one ────────────────────────────────────────
  const raise = await write({
    kind: 'JOURNAL',
    narration: 'bill raised',
    lines: [
      { ledgerId: customer.id, side: 'DR', amount: 50_000, bills: [{ kind: 'NEW_REF', billNo: 'CHK-1', amount: 50_000 }] },
      { ledgerId: sales, side: 'CR', amount: 50_000, costCentreId: brand.id },
    ],
  })
  let open = await openBills(tx, customer.id)
  check('a new bill stands open for its full amount', open.find((b) => b.billNo === 'CHK-1')?.pending === 50_000)
  const receipt = await write({
    kind: 'RECEIPT',
    lines: [
      { ledgerId: bank, side: 'DR', amount: 20_000 },
      { ledgerId: customer.id, side: 'CR', amount: 20_000, bills: [{ kind: 'AGAINST_REF', billNo: 'CHK-1', amount: 20_000 }] },
    ],
  })
  open = await openBills(tx, customer.id)
  check('money against a bill leaves the rest open', open.find((b) => b.billNo === 'CHK-1')?.pending === 30_000)
  r = await refused(
    () => write({ kind: 'RECEIPT', lines: [{ ledgerId: bank, side: 'DR', amount: 40_000 }, { ledgerId: customer.id, side: 'CR', amount: 40_000, bills: [{ kind: 'AGAINST_REF', billNo: 'CHK-1', amount: 40_000 }] }] }),
    'OVER_SETTLED',
  )
  check('more than is left on a bill cannot be settled', isTrue(r), why(r))
  r = await refused(
    () => write({ kind: 'RECEIPT', lines: [{ ledgerId: bank, side: 'DR', amount: 40_000 }, { ledgerId: customer.id, side: 'CR', amount: 40_000, bills: [{ kind: 'AGAINST_REF', billNo: 'CHK-1', amount: 20_000 }, { kind: 'AGAINST_REF', billNo: 'CHK-1', amount: 20_000 }] }] }),
    'OVER_SETTLED',
  )
  check('two settlements of one bill in one voucher cannot take more than is left between them', isTrue(r), why(r))
  const two = await write({
    kind: 'RECEIPT',
    lines: [
      { ledgerId: bank, side: 'DR', amount: 30_000 },
      { ledgerId: customer.id, side: 'CR', amount: 30_000, bills: [{ kind: 'AGAINST_REF', billNo: 'CHK-1', amount: 20_000 }, { kind: 'AGAINST_REF', billNo: 'CHK-1', amount: 10_000 }] },
    ],
  })
  open = await openBills(tx, customer.id)
  check('two settlements of one bill in one voucher add up, and clear it', !open.some((b) => b.billNo === 'CHK-1'), two.voucherNo)
  r = await refused(
    () => write({ kind: 'RECEIPT', lines: [{ ledgerId: bank, side: 'DR', amount: 1 }, { ledgerId: customer.id, side: 'CR', amount: 1, bills: [{ kind: 'AGAINST_REF', billNo: 'NOPE-9', amount: 1 }] }] }),
    'NO_SUCH_BILL',
  )
  check('a bill the party does not have cannot be settled', isTrue(r), why(r))
  r = await refused(
    () => write({ kind: 'JOURNAL', lines: [{ ledgerId: customer.id, side: 'DR', amount: 5, bills: [{ kind: 'NEW_REF', billNo: 'CHK-1', amount: 5 }] }, { ledgerId: sales, side: 'CR', amount: 5 }] }),
    'BILL_EXISTS',
  )
  check('a bill number cannot be raised twice for one party', isTrue(r), why(r))
  r = await refused(
    () => write({ kind: 'JOURNAL', lines: [{ ledgerId: rent.id, side: 'DR', amount: 5, bills: [{ kind: 'NEW_REF', billNo: 'X', amount: 5 }] }, { ledgerId: capital.id, side: 'CR', amount: 5 }] }),
    'NOT_BILL_WISE',
  )
  check('bills only on a ledger kept bill by bill', isTrue(r), why(r))
  const advance = await write({ kind: 'RECEIPT', lines: [{ ledgerId: bank, side: 'DR', amount: 7_000 }, { ledgerId: customer.id, side: 'CR', amount: 7_000 }] })
  open = await openBills(tx, customer.id)
  check('money with no bill named stays on account under its voucher number', open.find((b) => b.billNo === advance.voucherNo)?.pending === -7_000)

  // ── Cancelling ───────────────────────────────────────────────
  r = await refused(() => cancelVoucher(tx, raise.id, 'mistake', userId), 'BILL_SETTLED')
  check('a voucher whose bill has been settled cannot be cancelled first', isTrue(r), why(r))
  await cancelVoucher(tx, two.id, 'cheque returned', userId)
  open = await openBills(tx, customer.id)
  check('cancelling a receipt opens its bill again', open.find((b) => b.billNo === 'CHK-1')?.pending === 30_000)
  const kept = await tx.voucher.findUniqueOrThrow({ where: { id: two.id }, select: { voucherNo: true, status: true, _count: { select: { lines: true } } } })
  check('a cancelled voucher keeps its number and lines', kept.status === 'CANCELLED' && kept._count.lines === 2 && kept.voucherNo === two.voucherNo)
  r = await refused(() => cancelVoucher(tx, two.id, 'again', userId), 'ALREADY_CANCELLED')
  check('a voucher is cancelled once', isTrue(r), why(r))

  // ── Altering ─────────────────────────────────────────────────
  const before = await tx.voucher.findUniqueOrThrow({ where: { id: pay.id } })
  await writeVoucher(
    tx,
    v({ kind: 'PAYMENT', lines: [{ ledgerId: rent.id, side: 'DR', amount: 26_000, costCentreId: brand.id }, { ledgerId: bank, side: 'CR', amount: 26_000 }] }),
    userId,
    { id: before.id, kind: before.kind, voucherNo: before.voucherNo, financialYear: before.financialYear, date: before.date },
  )
  const after = await tx.voucher.findUniqueOrThrow({ where: { id: pay.id }, include: { lines: true } })
  check('an altered voucher keeps its number and takes the new amount', after.voucherNo === before.voucherNo && Number(after.amount) === 26_000 && after.lines.length === 2)
  r = await refused(
    () => writeVoucher(tx, v({ kind: 'JOURNAL', lines: [{ ledgerId: rent.id, side: 'DR', amount: 1 }, { ledgerId: capital.id, side: 'CR', amount: 1 }] }), userId, { id: before.id, kind: before.kind, voucherNo: before.voucherNo, financialYear: before.financialYear, date: before.date }),
    'KIND_FIXED',
  )
  check('a voucher keeps its type', isTrue(r), why(r))

  // ── Closed periods ───────────────────────────────────────────
  await tx.company.update({ where: { id: company.id }, data: { booksLockedUpTo: dayValue(today) } })
  r = await refused(() => write({ kind: 'CONTRA', lines: [{ ledgerId: cash, side: 'DR', amount: 1 }, { ledgerId: bank, side: 'CR', amount: 1 }] }), 'PERIOD_LOCKED')
  check('nothing is entered in a closed period', isTrue(r), why(r))
  r = await refused(() => cancelVoucher(tx, raise.id, 'x', userId), 'PERIOD_LOCKED')
  check('nothing is cancelled in a closed period', isTrue(r), why(r))
  await tx.company.update({ where: { id: company.id }, data: { booksLockedUpTo: null } })

  // ── The trial balance agrees with itself and with the ledger ──
  let s = await booksSettings(tx)
  let tb = await trialBalance(tx, { from: s.booksStart!, to: today }, s)
  check('the trial balance agrees', tb.totals.closingDr === tb.totals.closingCr && tb.totals.dr === tb.totals.cr, `Dr ${tb.totals.closingDr} Cr ${tb.totals.closingCr}`)
  const stmt = await ledgerStatement(tx, customer.id, { from: s.booksStart!, to: today }, s)
  const lastBalance = stmt.rows.length ? stmt.rows[stmt.rows.length - 1].balance : stmt.opening
  check('a ledger statement runs to its closing balance', lastBalance === stmt.closing && stmt.closing === tb.ledgers.find((l) => l.id === customer.id)?.closing, `${stmt.closing}`)
  const rentRow = tb.ledgers.find((l) => l.id === rent.id)!
  const indirectRow = tb.groups.find((g) => g.id === indirect.id)!
  check('a group holds the sum of its ledgers', indirectRow.closing >= rentRow.closing && rentRow.closing === 26_000)
  const cashRow = tb.ledgers.find((l) => l.id === cash)!
  check('cash shows what came out of the bank', cashRow.dr >= 5_000)

  // Opening balances that do not agree show as a difference, not hidden.
  await tx.ledger.update({ where: { id: capital.id }, data: { openingBalance: -100_000 } })
  s = await booksSettings(tx)
  tb = await trialBalance(tx, { from: s.booksStart!, to: today }, s)
  check('opening balances out by ₹1,00,000 show as a difference', tb.openingDifference === -100_000, `${tb.openingDifference}`)
  await tx.ledger.update({ where: { id: cash }, data: { openingBalance: 100_000 } })
  tb = await trialBalance(tx, { from: s.booksStart!, to: today }, s)
  check('and balance once the other side is entered', tb.openingDifference === 0)

  // ── A closed year's profit is carried, with no closing entry ──
  const lastYearStart = fyStartOf(new Date(dayValue(fyStart).getTime() - 86_400_000).toISOString().slice(0, 10), company.fyStartMonth)
  await tx.company.update({ where: { id: company.id }, data: { booksStartDate: dayValue(lastYearStart) } })
  const lastYearDay = new Date(dayValue(fyStart).getTime() - 10 * 86_400_000).toISOString().slice(0, 10)
  await write({ kind: 'JOURNAL', date: lastYearDay, lines: [{ ledgerId: customer.id, side: 'DR', amount: 1_000 }, { ledgerId: sales, side: 'CR', amount: 1_000 }] })
  s = await booksSettings(tx)
  tb = await trialBalance(tx, { from: fyStart, to: today }, s)
  const salesRow = tb.ledgers.find((l) => l.id === sales)!
  const pl = tb.ledgers.find((l) => l.systemKey === 'PROFIT_LOSS')!
  check("last year's sales are not in this year's opening", salesRow.opening === 0, `${salesRow.opening}`)
  check("last year's profit opens in the Profit & Loss A/c", pl.opening === -1_000, `${pl.opening}`)
  check('and the trial balance still agrees', tb.totals.closingDr === tb.totals.closingCr, `Dr ${tb.totals.closingDr} Cr ${tb.totals.closingCr}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
