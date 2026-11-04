// Accounts with the day the books start still to come (set ahead of go-live):
// every report opens, nothing posts before the day, and vouchers before it are
// refused.
//
// Runs inside one transaction that always throws: nothing is kept. Run it from
// apps/api, so the database settings load:
//
//   cd apps/api
//   npx tsx ../../tools/check-accounts-future-start.ts
import { prisma } from '../packages/database/src/index'
import type { Prisma } from '@prisma/client'
import { ensureChart } from '../apps/api/src/services/accounts/chart.service'
import { booksSettings, dayValue, ledgerStatement, periodFrom, todayIst, trialBalance } from '../apps/api/src/services/accounts/books.service'
import { pendingDocuments, postDocument } from '../apps/api/src/services/accounts/posting.service'
import { outstanding } from '../apps/api/src/services/accounts/outstanding.service'
import { balanceSheet, profitAndLoss } from '../apps/api/src/services/accounts/finalAccounts.service'
import { tdsDeducted } from '../apps/api/src/services/accounts/tdsBooks.service'
import { voucherSchema, writeVoucher } from '../apps/api/src/services/accounts/voucher.service'
import { accountsDashboard } from '../apps/api/src/services/accounts/dashboard.service'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const opens = async (label: string, fn: () => Promise<unknown>) => {
  try {
    await fn()
    check(`${label} opens`, true)
  } catch (e) {
    check(`${label} opens`, false, (e as Error).message)
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
      { timeout: 600_000, maxWait: 20_000 },
    )
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

async function run(tx: Prisma.TransactionClient) {
  const today = todayIst()
  const [y, m] = today.split('-').map(Number)
  const nextFirst = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  const company = await tx.company.findFirstOrThrow({ select: { id: true } })
  await tx.voucher.deleteMany({})
  await tx.company.update({ where: { id: company.id }, data: { booksStartDate: dayValue(nextFirst), booksLockedUpTo: null } })
  const s = await booksSettings(tx)
  console.log(`books start ${s.booksStart}, today ${today}`)

  let period = { from: today, to: today }
  await opens('a period asked with no dates', async () => {
    period = periodFrom({}, s)
  })
  await opens('Trial Balance', () => trialBalance(tx, period, s))
  const cash = await tx.ledger.findFirstOrThrow({ where: { systemKey: 'CASH' }, select: { id: true } })
  await opens('Ledger', () => ledgerStatement(tx, cash.id, period, s))
  await opens('Outstanding', () => outstanding(tx, 'receivable', today))
  await opens('Profit & Loss', () => profitAndLoss(tx, period, s))
  await opens('Balance Sheet', () => balanceSheet(tx, today, s))
  await opens('TDS', () => tdsDeducted(tx, period.from, today, today))
  await opens('Dashboard', () => accountsDashboard(tx, today))

  const pending = await pendingDocuments(tx)
  check('no document waits before the books start', pending.pending.length === 0, `${pending.pending.length}`)
  const inv = await tx.salesInvoice.findFirst({ select: { id: true } })
  if (inv) {
    await postDocument(tx, 'SALES_INVOICE', inv.id)
    const n = await tx.voucher.count({ where: { sourceId: inv.id } })
    check('an invoice dated before the books start stays out of them', n === 0)
  }
  const bank = await tx.ledger.findFirstOrThrow({ where: { partyType: 'BANK', isActive: true }, select: { id: true } })
  const charges = await tx.ledger.findFirstOrThrow({ where: { systemKey: 'BANK_CHARGES' }, select: { id: true } })
  const user = await tx.user.findFirstOrThrow({ where: { status: 'ACTIVE' }, select: { id: true } })
  let refused = ''
  try {
    await writeVoucher(tx, voucherSchema.parse({ kind: 'PAYMENT', date: today, lines: [{ ledgerId: charges.id, side: 'DR', amount: 10 }, { ledgerId: bank.id, side: 'CR', amount: 10 }] }), user.id)
  } catch (e) {
    refused = (e as Error).message
  }
  check('a voucher dated before the books start is refused, with the day in words', /before the books start on \d{2} \w{3,4} \d{4}/.test(refused), refused)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
