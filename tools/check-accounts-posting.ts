// Sales and Purchase documents into the books, checked against the documents
// already in the database: every invoice, receipt, credit note, bill, supplier
// payment and posted purchase note is posted, and then —
//
//   - every voucher balances, and carries its document's own total;
//   - each customer's ledger (what the documents posted to it; vouchers typed in
//     Accounts are left out) equals what Sales says they owe, less what they
//     hold on account; each supplier's ledger equals what Purchase says we owe;
//   - posting again changes nothing;
//   - a closed period refuses a change to a document dated in it, but not a
//     save that changes nothing;
//   - moving the books' start past a document takes its voucher out.
//
// Runs inside one transaction that always throws: nothing is kept. Run it from
// apps/api, so the database settings load:
//
//   cd apps/api
//   npx tsx ../../tools/check-accounts-posting.ts
import { prisma } from '../packages/database/src/index'
import type { Prisma } from '@prisma/client'
import { ensureChart } from '../apps/api/src/services/accounts/chart.service'
import { dayValue, todayIst } from '../apps/api/src/services/accounts/books.service'
import { postDocument, type SourceType } from '../apps/api/src/services/accounts/posting.service'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const r2 = (n: number) => Math.round(n * 100) / 100
const n = (v: unknown) => Number(v ?? 0)

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
  const company = await tx.company.findFirstOrThrow({ select: { id: true } })
  // Every document in the database falls inside the books.
  await tx.company.update({ where: { id: company.id }, data: { booksStartDate: dayValue('2024-04-01'), booksLockedUpTo: null } })
  await tx.voucher.deleteMany({ where: { sourceType: { not: null } } })

  const docs: Array<[SourceType, string]> = [
    ...(await tx.salesInvoice.findMany({ select: { id: true } })).map((d) => ['SALES_INVOICE', d.id] as [SourceType, string]),
    ...(await tx.purchaseInvoice.findMany({ select: { id: true } })).map((d) => ['PURCHASE_BILL', d.id] as [SourceType, string]),
    ...(await tx.creditNote.findMany({ select: { id: true } })).map((d) => ['CREDIT_NOTE', d.id] as [SourceType, string]),
    ...(await tx.purchaseNote.findMany({ select: { id: true } })).map((d) => ['PURCHASE_NOTE', d.id] as [SourceType, string]),
    ...(await tx.paymentReceipt.findMany({ select: { id: true } })).map((d) => ['SALES_RECEIPT', d.id] as [SourceType, string]),
    ...(await tx.supplierPayment.findMany({ select: { id: true } })).map((d) => ['SUPPLIER_PAYMENT', d.id] as [SourceType, string]),
  ]
  const counts: Record<string, number> = {}
  const errors: string[] = []
  for (const [type, id] of docs) {
    try {
      const r = await postDocument(tx, type, id)
      counts[`${type}:${r}`] = (counts[`${type}:${r}`] ?? 0) + 1
    } catch (e) {
      errors.push(`${type} ${id}: ${(e as Error).message}`)
    }
  }
  console.log('posted:', JSON.stringify(counts))
  check('every document posts without an error', errors.length === 0, errors.slice(0, 5).join(' | '))

  // ── Each voucher balances and carries its document's total ──
  const unbalanced = await tx.$queryRawUnsafe<Array<{ voucherNo: string; dr: number; cr: number }>>(
    `SELECT v."voucherNo", SUM(l.debit)::float8 AS dr, SUM(l.credit)::float8 AS cr
       FROM ld_erp.acc_vouchers v JOIN ld_erp.acc_voucher_lines l ON l."voucherId" = v.id
      WHERE v."sourceType" IS NOT NULL GROUP BY v.id, v."voucherNo" HAVING SUM(l.debit) <> SUM(l.credit) OR SUM(l.debit) <> v.amount`,
  )
  check('every voucher balances and its amount is its debits', unbalanced.length === 0, unbalanced.slice(0, 3).map((u) => `${u.voucherNo} ${u.dr}/${u.cr}`).join(', '))

  const invoices = await tx.salesInvoice.findMany({ where: { status: { not: 'CANCELLED' } }, select: { id: true, invoiceNumber: true, totalAmount: true, customerId: true } })
  let wrong = 0
  for (const inv of invoices) {
    const v = await tx.voucher.findUnique({ where: { sourceType_sourceId: { sourceType: 'SALES_INVOICE', sourceId: inv.id } }, include: { lines: { include: { ledger: { select: { customerId: true } } } } } })
    const owed = v?.lines.filter((l) => l.ledger.customerId === inv.customerId).reduce((t, l) => t + n(l.debit) - n(l.credit), 0) ?? -1
    if (r2(owed) !== r2(n(inv.totalAmount))) wrong++
  }
  check('each invoice charges its customer its total', wrong === 0, `${invoices.length} invoices, ${wrong} wrong`)
  const cancelled = await tx.salesInvoice.count({ where: { status: 'CANCELLED' } })
  const cancelledPosted = await tx.voucher.count({ where: { sourceType: 'SALES_INVOICE', status: 'POSTED', sourceId: { in: (await tx.salesInvoice.findMany({ where: { status: 'CANCELLED' }, select: { id: true } })).map((i) => i.id) } } })
  check('a cancelled invoice has no voucher standing', cancelledPosted === 0, `${cancelled} cancelled`)

  // ── Customers: the ledger agrees with Sales ──
  const today = new Date(`${todayIst()}T23:59:59.999+05:30`)
  const custLedgers = await tx.ledger.findMany({ where: { partyType: 'CUSTOMER' }, select: { id: true, name: true, customerId: true } })
  const mismatches: string[] = []
  for (const l of custLedgers) {
    const agg = await tx.voucherLine.aggregate({ where: { ledgerId: l.id, voucher: { status: 'POSTED', sourceType: { not: null }, date: { lte: today } } }, _sum: { debit: true, credit: true } })
    const ledger = r2(n(agg._sum.debit) - n(agg._sum.credit))
    const [owed, rcpt, cn] = await Promise.all([
      tx.salesInvoice.aggregate({ where: { customerId: l.customerId!, status: { not: 'CANCELLED' } }, _sum: { balanceAmount: true } }),
      tx.paymentReceipt.findMany({ where: { customerId: l.customerId!, status: 'POSTED' }, select: { onAccount: true, mode: true, chequeDate: true } }),
      tx.creditNote.aggregate({ where: { customerId: l.customerId!, status: 'ISSUED' }, _sum: { onAccount: true } }),
    ])
    // A post-dated cheque counts from its date, as in Sales.
    const held = (r: { mode: string; chequeDate: Date | null }) => (r.mode === 'CHEQUE' || r.mode === 'PDC') && r.chequeDate && r.chequeDate > today
    const advance = rcpt.filter((r) => !held(r)).reduce((t, r) => t + n(r.onAccount), 0)
    const sales = r2(n(owed._sum.balanceAmount) - advance - n(cn._sum.onAccount))
    if (ledger !== sales) mismatches.push(`${l.name}: ledger ${ledger}, sales ${sales}`)
  }
  check("every customer's ledger equals what Sales says they owe", mismatches.length === 0, mismatches.slice(0, 4).join(' | '))

  // ── Suppliers: the ledger agrees with Purchase ──
  const supLedgers = await tx.ledger.findMany({ where: { partyType: 'SUPPLIER' }, select: { id: true, name: true, supplierId: true } })
  const supMis: string[] = []
  for (const l of supLedgers) {
    // A note raised without a bill moves the ledger but no bill in Purchase.
    const loose = await tx.purchaseNote.findMany({ where: { supplierId: l.supplierId!, billId: null, status: 'POSTED' }, select: { totalAmount: true, effect: true } })
    const looseSum = loose.reduce((t, x) => t + (x.effect === 'REDUCES_PAYABLE' ? 1 : -1) * n(x.totalAmount), 0)
    const agg = await tx.voucherLine.aggregate({ where: { ledgerId: l.id, voucher: { status: 'POSTED', sourceType: { not: null } } }, _sum: { debit: true, credit: true } })
    const ledger = r2(n(agg._sum.credit) - n(agg._sum.debit))
    const bills = await tx.purchaseInvoice.findMany({ where: { supplierId: l.supplierId!, status: { not: 'CANCELLED' } }, select: { totalAmount: true, tdsAmount: true, noteAdjustment: true, paidAmount: true, balanceAmount: true, payments: { where: { status: 'POSTED' }, select: { tdsAmount: true } } } })
    // Unclamped, the way the ledger counts it: what each bill still asks for.
    const purchase = r2(bills.reduce((t, b) => t + n(b.totalAmount) - n(b.tdsAmount) - n(b.noteAdjustment) - n(b.paidAmount) - b.payments.reduce((s, p) => s + n(p.tdsAmount), 0), 0) - looseSum)
    if (ledger !== purchase) supMis.push(`${l.name}: ledger ${ledger}, purchase ${purchase}`)
  }
  check("every supplier's ledger equals what Purchase says we owe", supMis.length === 0, supMis.slice(0, 4).join(' | '))

  // ── Posting again changes nothing ──
  let changed = 0
  for (const [type, id] of docs) {
    const r = await postDocument(tx, type, id)
    if (r !== 'unchanged' && r !== 'none') changed++
  }
  check('posting everything again changes nothing', changed === 0, `${changed} changed`)

  // ── A closed period ──
  const receipt = await tx.paymentReceipt.findFirst({ where: { status: 'POSTED' }, orderBy: { receiptDate: 'asc' }, select: { id: true, receiptNumber: true } })
  if (receipt) {
    await tx.company.update({ where: { id: company.id }, data: { booksLockedUpTo: dayValue(todayIst()) } })
    let threw = ''
    try {
      await postDocument(tx, 'SALES_RECEIPT', receipt.id)
    } catch (e) {
      threw = (e as { code?: string }).code ?? 'other'
    }
    check('a save that changes nothing goes through a closed period', threw === '')
    await tx.paymentReceipt.update({ where: { id: receipt.id }, data: { status: 'REVERSED', reversalReason: 'check' } })
    try {
      await postDocument(tx, 'SALES_RECEIPT', receipt.id)
    } catch (e) {
      threw = (e as { code?: string }).code ?? 'other'
    }
    check('reversing a receipt in a closed period is refused', threw === 'PERIOD_LOCKED', threw)
    await tx.company.update({ where: { id: company.id }, data: { booksLockedUpTo: null } })
    const r = await postDocument(tx, 'SALES_RECEIPT', receipt.id)
    const v = await tx.voucher.findUnique({ where: { sourceType_sourceId: { sourceType: 'SALES_RECEIPT', sourceId: receipt.id } }, select: { status: true, voucherNo: true } })
    check('once reopened, the reversal cancels its voucher and keeps its number', r === 'cancelled' && v?.status === 'CANCELLED' && v.voucherNo === receipt.receiptNumber)
  }

  // ── Books starting later take earlier documents out ──
  await tx.company.update({ where: { id: company.id }, data: { booksStartDate: dayValue('2099-04-01') } })
  const inv = invoices[0]
  if (inv) {
    const r = await postDocument(tx, 'SALES_INVOICE', inv.id)
    check('a document dated before the books start has no voucher', r === 'removed', r)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
