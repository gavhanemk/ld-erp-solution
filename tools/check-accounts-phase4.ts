// Accounts, phase 4: the final accounts.
//
//   - the balance sheet balances, on any day, with the only gap being what
//     the opening balances are out by;
//   - its profit line is the profit and loss account's net profit;
//   - closing stock comes from inventory, or from the accountant for one
//     day, and moves the gross profit and the balance sheet alike;
//   - profit by brand adds up to the whole;
//   - two periods back to back add up to the one they make;
//   - opening stock is the old books' stock until the books' own begins;
//   - a year closed without a closing entry still carries its profit, and
//     its stock, into the next.
//
// Runs inside one transaction that always throws: nothing is kept. Run it from
// apps/api, so the database settings load:
//
//   cd apps/api
//   npx tsx ../../tools/check-accounts-phase4.ts
import { prisma } from '../packages/database/src/index'
import type { Prisma } from '@prisma/client'
import { ensureChart } from '../apps/api/src/services/accounts/chart.service'
import { booksSettings, dayValue, todayIst, trialBalance } from '../apps/api/src/services/accounts/books.service'
import { postDocument, type SourceType } from '../apps/api/src/services/accounts/posting.service'
import { balanceSheet, inventoryValue, profitAndLoss, setStockValue, stockOn } from '../apps/api/src/services/accounts/finalAccounts.service'
import { voucherSchema, writeVoucher } from '../apps/api/src/services/accounts/voucher.service'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const r2 = (n: number) => Math.round(n * 100) / 100
const near = (a: number, b: number) => Math.abs(a - b) < 0.01
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
  const company = await tx.company.findFirstOrThrow({ select: { id: true } })
  const user = await tx.user.findFirstOrThrow({ where: { status: 'ACTIVE' }, select: { id: true } })
  await tx.company.update({ where: { id: company.id }, data: { booksStartDate: dayValue('2026-10-01'), booksLockedUpTo: null } })
  // Every document from the start in the books.
  const docs: Array<[SourceType, string]> = [
    ...(await tx.salesInvoice.findMany({ select: { id: true } })).map((d) => ['SALES_INVOICE', d.id] as [SourceType, string]),
    ...(await tx.purchaseInvoice.findMany({ select: { id: true } })).map((d) => ['PURCHASE_BILL', d.id] as [SourceType, string]),
    ...(await tx.creditNote.findMany({ select: { id: true } })).map((d) => ['CREDIT_NOTE', d.id] as [SourceType, string]),
    ...(await tx.paymentReceipt.findMany({ select: { id: true } })).map((d) => ['SALES_RECEIPT', d.id] as [SourceType, string]),
    ...(await tx.supplierPayment.findMany({ select: { id: true } })).map((d) => ['SUPPLIER_PAYMENT', d.id] as [SourceType, string]),
  ]
  for (const [t, id] of docs) await postDocument(tx, t, id)
  let s = await booksSettings(tx)

  // ── The balance sheet balances ───────────────────────────────
  for (const day of ['2026-10-01', '2026-10-15', today]) {
    const bs = await balanceSheet(tx, day, s)
    const tb = await trialBalance(tx, { from: bs.fyStart, to: day }, s)
    check(`the balance sheet on ${day} balances, short only by the opening difference`, near(r2(bs.assetsTotal - bs.liabilitiesTotal), bs.openingDifference) && near(bs.openingDifference, tb.openingDifference), `assets ${bs.assetsTotal}, liabilities ${bs.liabilitiesTotal}, opening out by ${tb.openingDifference}`)
  }
  let bs = await balanceSheet(tx, today, s)
  let pl = await profitAndLoss(tx, { from: '2026-04-01', to: today }, s)
  check("the balance sheet's profit is the profit and loss account's", near(bs.netProfit, pl.netProfit) && bs.liabilities.some((r) => r.id === 'profit' && near(r.amount, pl.netProfit)), `${pl.netProfit}`)
  const sales = pl.blocks.find((b) => b.key === 'SALES_ACCOUNTS')!
  check('sales show as income, purchases as cost', sales.total > 0 && pl.blocks.find((b) => b.key === 'PURCHASE_ACCOUNTS')!.total > 0, `sales ${sales.total}`)
  check('a period reaching back past the books start runs from the start of the year', pl.period.from === '2026-04-01')

  // ── Stock ────────────────────────────────────────────────────
  const stockLedgers = await tx.ledger.findMany({ where: { group: { systemKey: 'STOCK_IN_HAND' } }, select: { openingBalance: true } })
  const s0 = r2(stockLedgers.reduce((t, l) => t + Number(l.openingBalance), 0))
  check("opening stock is the old books' until the books' own begins", near(pl.openingStock.value, s0) && pl.openingStock.source === 'books', `${pl.openingStock.value} / ${s0}`)
  const inv = await inventoryValue(tx, today)
  check("closing stock is inventory's own value", pl.closingStock.source === 'inventory' && near(pl.closingStock.value, inv), `${inv}`)
  const grossBefore = pl.grossProfit
  await setStockValue(tx, today, r2(inv + 50_000), 'physical count', user.id)
  pl = await profitAndLoss(tx, { from: '2026-04-01', to: today }, s)
  bs = await balanceSheet(tx, today, s)
  check("the accountant's value for a day takes the place of inventory's", pl.closingStock.source === 'set' && near(pl.closingStock.value, inv + 50_000))
  check('and moves the gross profit by the same amount', near(pl.grossProfit - grossBefore, 50_000), `${r2(pl.grossProfit - grossBefore)}`)
  check('while the balance sheet still balances', near(r2(bs.assetsTotal - bs.liabilitiesTotal), bs.openingDifference) && near(bs.stock.value, inv + 50_000))
  check('a stock value before the books start is refused', (await code(() => setStockValue(tx, '2026-09-30', 1, null, user.id))) === 'BEFORE_BOOKS')
  check('a stock value for tomorrow is refused', (await code(() => setStockValue(tx, '2099-01-01', 1, null, user.id))) === 'FUTURE_DATE')
  await setStockValue(tx, today, null, null, user.id)
  check('clearing it hands the day back to inventory', (await stockOn(tx, today, s)).source === 'inventory')

  // ── By brand ─────────────────────────────────────────────────
  pl = await profitAndLoss(tx, { from: '2026-04-01', to: today }, s)
  const sumNet = r2(pl.brand.reduce((t, b) => t + b.netProfit, 0))
  const sumGross = r2(pl.brand.reduce((t, b) => t + b.grossProfit, 0))
  check('profit by brand adds up to the whole', near(sumNet, pl.netProfit) && near(sumGross, pl.grossProfit), `${sumNet} / ${pl.netProfit}`)
  const ld = pl.brand.find((b) => b.id !== '' && b.grossProfit !== 0)
  check('sales carry their brand', !!ld, ld ? `${ld.name} ${ld.grossProfit}` : 'no brand has a figure')

  // ── Two periods back to back ─────────────────────────────────
  const a = await profitAndLoss(tx, { from: '2026-04-01', to: '2026-10-20' }, s)
  const b = await profitAndLoss(tx, { from: '2026-10-21', to: today }, s)
  check('two periods back to back add up to the one they make', near(r2(a.netProfit + b.netProfit), pl.netProfit), `${a.netProfit} + ${b.netProfit} = ${pl.netProfit}`)
  check("the second period opens with the first's closing stock", near(b.openingStock.value, a.closingStock.value))

  // ── A closed year carries its profit and its stock ───────────
  await tx.company.update({ where: { id: company.id }, data: { booksStartDate: dayValue('2025-04-01') } })
  s = await booksSettings(tx)
  const cust = await tx.ledger.findFirstOrThrow({ where: { partyType: 'CUSTOMER' }, select: { id: true } })
  const salesLedger = await tx.ledger.findUniqueOrThrow({ where: { systemKey: 'SALES' }, select: { id: true } })
  await writeVoucher(tx, voucherSchema.parse({ kind: 'JOURNAL', date: '2026-03-20', lines: [{ ledgerId: cust.id, side: 'DR', amount: 7_000 }, { ledgerId: salesLedger.id, side: 'CR', amount: 7_000 }] }), user.id)
  // Last year's closing stock valued above what the books opened with.
  await setStockValue(tx, '2026-03-31', r2(s0 + 30_000), 'year-end count', user.id)
  const last = await profitAndLoss(tx, { from: '2025-04-01', to: '2026-03-31' }, s)
  check("last year's stock gain is in last year's profit", near(last.closingStock.value - last.openingStock.value, 30_000), `${last.closingStock.value - last.openingStock.value}`)
  const now = await profitAndLoss(tx, { from: '2026-04-01', to: today }, s)
  check("and this year opens with last year's closing stock", near(now.openingStock.value, s0 + 30_000))
  bs = await balanceSheet(tx, today, s)
  check('the balance sheet still balances across the year end', near(r2(bs.assetsTotal - bs.liabilitiesTotal), bs.openingDifference), `${bs.assetsTotal} / ${bs.liabilitiesTotal} / ${bs.openingDifference}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
