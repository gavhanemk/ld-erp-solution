// Accounts, phase 3: the old books brought in, outstanding, and the bank.
//
//   - the opening trial balance from a sheet: bad rows found before anything
//     is written, good ones set, a new ledger made under its group;
//   - unpaid bills from a sheet: checked, brought in, and each party's
//     opening balance becomes the total of its bills;
//   - outstanding: old bills aged, advances apart, every party's net equal to
//     its ledger, the whole equal to Sundry Debtors in the trial balance;
//   - an old bill settled from an Accounts receipt leaves the list, and its
//     bills can no longer be swept away by a new sheet;
//   - bank reconciliation: the bank's balance worked out from the books, bank
//     dates refused before the voucher or after today, and kept when a
//     document's voucher is rewritten.
//
// Runs inside one transaction that always throws: nothing is kept. Run it from
// apps/api, so the database settings load:
//
//   cd apps/api
//   npx tsx ../../tools/check-accounts-phase3.ts
import { prisma } from '../packages/database/src/index'
import type { Prisma } from '@prisma/client'
import { ensureChart } from '../apps/api/src/services/accounts/chart.service'
import { booksSettings, dayValue, todayIst, trialBalance } from '../apps/api/src/services/accounts/books.service'
import { outstanding } from '../apps/api/src/services/accounts/outstanding.service'
import { bankReco, setBankDates } from '../apps/api/src/services/accounts/bankReco.service'
import { planBalances, planBills, runBalances, runBills } from '../apps/api/src/services/accounts/opening.service'
import { voucherSchema, writeVoucher } from '../apps/api/src/services/accounts/voucher.service'
import { postDocument } from '../apps/api/src/services/accounts/posting.service'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const csv = (lines: string[]) => Buffer.from(lines.join('\n'))
async function code(fn: () => Promise<unknown>) {
  try {
    await fn()
    return 'none'
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message
  }
}

async function main() {
  await ensureChart(true)
  try {
    await prisma.$transaction(
      async (tx) => {
        await run(tx)
        throw ROLLBACK
      },
      { timeout: 300_000, maxWait: 20_000 },
    )
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

async function run(tx: Prisma.TransactionClient) {
  const today = todayIst()
  const company = await tx.company.findFirstOrThrow({ select: { id: true } })
  await tx.company.update({ where: { id: company.id }, data: { booksStartDate: dayValue('2026-10-01'), booksLockedUpTo: null } })
  const user = await tx.user.findFirstOrThrow({ where: { status: 'ACTIVE' }, select: { id: true } })

  // ── The opening trial balance ────────────────────────────────
  const head = 'Ledger*,Group (for a new ledger),Debit,Credit'
  let plan = await planBalances(tx, csv([head, 'Cash,,5000,', 'Capital – Check,Capital Account,,5000', 'No Such Ledger,,100,', 'Bank Charges,,10,10', 'Cash,,1,']), 'tb.csv')
  const probRows = plan.plans.filter((p) => p.problems.length).map((p) => p.row)
  check('bad rows are found before anything is written', plan.summary.problems === 3 && probRows.join(',') === '4,5,6', probRows.join(','))
  plan = await planBalances(tx, csv([head, 'Cash,,5000,', 'Capital – Check,Capital Account,,5000']), 'tb.csv')
  check('a clean sheet agrees with itself', plan.summary.problems === 0 && plan.summary.difference === 0 && plan.summary.newLedgers === 1)
  await runBalances(tx, csv([head, 'Cash,,5000,', 'Capital – Check,Capital Account,,5000']), 'tb.csv')
  const cash = await tx.ledger.findUniqueOrThrow({ where: { systemKey: 'CASH' }, select: { openingBalance: true } })
  const capital = await tx.ledger.findFirst({ where: { name: 'Capital – Check' }, select: { openingBalance: true, group: { select: { systemKey: true } } } })
  check('the trial balance sets openings and makes the new ledger under its group', Number(cash.openingBalance) === 5000 && Number(capital?.openingBalance) === -5000 && capital?.group.systemKey === 'CAPITAL')

  // ── Unpaid bills ─────────────────────────────────────────────
  const party = await tx.ledger.findFirstOrThrow({ where: { partyType: 'CUSTOMER', billWise: true, customer: { NOT: { name: { contains: 'VHAGAR', mode: 'insensitive' } } } }, select: { id: true, name: true } })
  const bh = 'Party*,Bill no*,Bill date*,Due date,Amount still unpaid*,Bill or advance'
  const q = (s: string) => `"${s}"`
  let bills = await planBills(
    tx,
    csv([bh, `${q(party.name)},OLD-1,15-08-2026,14-09-2026,10000,Bill`, `${q(party.name)},OLD-2,2026-09-20,,5000,`, `${q(party.name)},ADV-1,01/09/2026,,2000,Advance`, `${q(party.name)},OLD-3,2026-10-05,,1,Bill`, `${q(party.name)},OLD-1,15-08-2026,,1,Bill`, 'Nobody At All,X-1,2026-09-01,,1,Bill']),
    'bills.csv',
  )
  check('bills dated after the start, twice over or for nobody are refused', bills.summary.problems === 3, bills.plans.filter((p) => p.problems.length).map((p) => `${p.row}:${p.problems[0]}`).join(' | '))
  const good = [`${q(party.name)},OLD-1,12-08-2026,14-09-2026,10000,Bill`, `${q(party.name)},OLD-2,2026-09-20,,5000,`, `${q(party.name)},ADV-1,01/09/2026,,2000,Advance`]
  bills = await planBills(tx, csv([bh, ...good]), 'bills.csv')
  // 12-08-2026 is the 12th of August, day first, as an Indian sheet writes it.
  check('the dates come through in any of the usual forms, day first', bills.summary.problems === 0 && bills.plans.map((p) => p.billDate).join(',') === '2026-08-12,2026-09-20,2026-09-01', bills.plans.map((p) => p.billDate).join(','))
  await runBills(tx, csv([bh, ...good]), 'bills.csv')
  const led = await tx.ledger.findUniqueOrThrow({ where: { id: party.id }, select: { openingBalance: true } })
  check("the party's opening balance is its bills less its advance", Number(led.openingBalance) === 13000, String(led.openingBalance))

  // ── Outstanding ──────────────────────────────────────────────
  let rec = await outstanding(tx, 'receivable', today)
  let p = rec.parties.find((x) => x.ledgerId === party.id)
  const old1 = p?.bills.find((b) => b.billNo === 'OLD-1')
  const days = Math.round((dayValue(today).getTime() - dayValue('2026-09-14').getTime()) / 86_400_000)
  check('an old bill is aged from its due date', old1?.days === days && old1.amount === 10000, `${old1?.days} days`)
  check('an advance stands apart from the bills', p?.bills.some((b) => b.billNo === 'ADV-1' && b.kind === 'advance' && b.amount === -2000) === true && (p?.advance ?? 0) >= 2000)
  const s = await booksSettings(tx)
  const tb = await trialBalance(tx, { from: s.booksStart!, to: today }, s)
  const closing = new Map(tb.ledgers.map((l) => [l.id, l.closing]))
  const off = rec.parties.filter((x) => Math.abs(x.net - (closing.get(x.ledgerId) ?? 0)) > 0.005)
  check("every party's net is its ledger balance", off.length === 0, off.slice(0, 3).map((x) => `${x.name} ${x.net}/${closing.get(x.ledgerId)}`).join(' | '))
  const sdGroup = await tx.ledgerGroup.findUniqueOrThrow({ where: { systemKey: 'SUNDRY_DEBTORS' }, select: { id: true } })
  const sd = tb.groups.find((g) => g.id === sdGroup.id)!
  check('receivables add up to Sundry Debtors in the trial balance', Math.abs(rec.summary.net - sd.closing) < 0.01, `${rec.summary.net} / ${sd.closing}`)
  const pay = await outstanding(tx, 'payable', today)
  const scGroup = await tx.ledgerGroup.findUniqueOrThrow({ where: { systemKey: 'SUNDRY_CREDITORS' }, select: { id: true } })
  const sc = tb.groups.find((g) => g.id === scGroup.id)!
  check('payables add up to Sundry Creditors in the trial balance', Math.abs(pay.summary.net + sc.closing) < 0.01, `${pay.summary.net} / ${-sc.closing}`)

  // ── An old bill settled from Accounts ────────────────────────
  const bank = await tx.ledger.findFirstOrThrow({ where: { partyType: 'BANK', isActive: true }, select: { id: true } })
  const rv = await writeVoucher(
    tx,
    voucherSchema.parse({ kind: 'RECEIPT', date: today, lines: [{ ledgerId: bank.id, side: 'DR', amount: 10000 }, { ledgerId: party.id, side: 'CR', amount: 10000, bills: [{ kind: 'AGAINST_REF', billNo: 'OLD-1', amount: 10000 }] }] }),
    user.id,
  )
  rec = await outstanding(tx, 'receivable', today)
  p = rec.parties.find((x) => x.ledgerId === party.id)
  check('an Accounts receipt settles an old bill', !p?.bills.some((b) => b.billNo === 'OLD-1'), rv.voucherNo)
  bills = await planBills(tx, csv([bh, `${q(party.name)},OLD-2,2026-09-20,,5000,`]), 'bills.csv')
  check('old bills with money against them cannot be replaced', bills.summary.problems === 1, bills.plans[0]?.problems[0])

  // ── Bank reconciliation ──────────────────────────────────────
  let reco = await bankReco(tx, bank.id, today)
  check("the bank's balance is the books' less what it has not credited, plus what it has not paid", reco.bankBalance === Math.round((reco.booksBalance - reco.notCredited + reco.notDebited) * 100) / 100)
  const line = reco.pending.find((r) => r.voucherNo === rv.voucherNo)!
  check('a new receipt waits to be credited', !!line && line.deposit === 10000)
  check('a bank date before the voucher is refused', (await code(() => setBankDates(tx, [{ lineId: line.lineId, bankDate: '2026-01-01' }]))) === 'BEFORE_VOUCHER')
  check('a bank date after today is refused', (await code(() => setBankDates(tx, [{ lineId: line.lineId, bankDate: '2099-01-01' }]))) === 'FUTURE_DATE')
  const before = reco.notCredited
  await setBankDates(tx, [{ lineId: line.lineId, bankDate: today }])
  reco = await bankReco(tx, bank.id, today)
  check('once the bank shows it, it is no longer waiting', reco.notCredited === Math.round((before - 10000) * 100) / 100 && reco.clearedThisMonth.some((r) => r.voucherNo === rv.voucherNo))

  // A document's voucher rewritten keeps its bank date.
  const receipt = await tx.paymentReceipt.findFirst({ where: { status: 'POSTED', bankAccountId: { not: null }, receiptDate: { gte: new Date('2026-10-01') } }, select: { id: true, receiptNumber: true } })
  if (receipt) {
    await postDocument(tx, 'SALES_RECEIPT', receipt.id)
    const v = await tx.voucher.findUniqueOrThrow({ where: { sourceType_sourceId: { sourceType: 'SALES_RECEIPT', sourceId: receipt.id } }, include: { lines: { include: { ledger: { select: { bankAccountId: true } } } } } })
    const bankLine = v.lines.find((l) => l.ledger.bankAccountId)!
    await setBankDates(tx, [{ lineId: bankLine.id, bankDate: today }])
    await tx.paymentReceipt.update({ where: { id: receipt.id }, data: { referenceNo: 'REWRITTEN-CHECK' } })
    const r = await postDocument(tx, 'SALES_RECEIPT', receipt.id)
    const after = await tx.voucherLine.findFirst({ where: { voucherId: v.id, ledgerId: bankLine.ledgerId } })
    check("rewriting a document's voucher keeps its bank date", r === 'updated' && after?.bankDate?.toISOString().slice(0, 10) === today, `${r} ${after?.bankDate?.toISOString()}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
