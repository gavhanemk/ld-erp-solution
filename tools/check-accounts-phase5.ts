// Accounts, phase 5: GST returns and TDS, checked against the books.
//
//   - GSTR-1: its tables add up to the net outward supply, and the portal
//     file carries every B2B invoice;
//   - GSTR-3B: tax on sales equals what the output GST ledgers took in the
//     month, input credit what the input GST ledgers took;
//   - input credit set against tax in the legal order, on worked examples;
//   - a GSTR-2B file matched against the bills: matched, differing, filed by
//     a supplier but not booked, and booked but not filed;
//   - TDS: deducted equals the bills' and payments' TDS, the due dates are
//     the 7th (30 April for March), and TDS customers deducted equals the
//     receipts'.
//
// Runs inside one transaction that always throws: nothing is kept. Run it from
// apps/api, so the database settings load:
//
//   cd apps/api
//   npx tsx ../../tools/check-accounts-phase5.ts
import { prisma } from '../packages/database/src/index'
import type { Prisma } from '@prisma/client'
import { ensureChart } from '../apps/api/src/services/accounts/chart.service'
import { dayValue, todayIst } from '../apps/api/src/services/accounts/books.service'
import { postDocument, type SourceType } from '../apps/api/src/services/accounts/posting.service'
import { gstr1, gstr1Json, gstr3b, match2b, read2b, setOffCredit } from '../apps/api/src/services/accounts/gst.service'
import { tdsByCustomers, tdsDeducted, tdsDueDate } from '../apps/api/src/services/accounts/tdsBooks.service'
import { voucherSchema, writeVoucher } from '../apps/api/src/services/accounts/voucher.service'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const r2 = (n: number) => Math.round(n * 100) / 100
const near = (a: number, b: number) => Math.abs(a - b) < 0.05
const tax = (t: { igst: number; cgst: number; sgst: number }) => r2(t.igst + t.cgst + t.sgst)

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
  // ── Set-off, on worked examples ──────────────────────────────
  let so = setOffCredit({ igst: 1000, cgst: 500, sgst: 500 }, { igst: 300, cgst: 800, sgst: 100 })
  check('IGST credit pays IGST first; CGST credit then pays CGST and IGST', so.cash.igst === 400 && so.cash.cgst === 0 && so.cash.sgst === 400 && so.carried.cgst === 0, JSON.stringify(so.cash))
  so = setOffCredit({ igst: 0, cgst: 1000, sgst: 1000 }, { igst: 1500, cgst: 200, sgst: 0 })
  check('spare IGST credit goes where CGST and SGST credit falls short', so.cash.cgst === 0 && so.cash.sgst === 300 && so.carried.igst === 0, JSON.stringify(so.cash))
  so = setOffCredit({ igst: 100, cgst: 100, sgst: 100 }, { igst: 0, cgst: 500, sgst: 0 })
  check('CGST credit never pays SGST', so.cash.sgst === 100 && so.paid.cgst.igst === 100 && so.carried.cgst === 300)
  so = setOffCredit({ igst: 100, cgst: 0, sgst: 0 }, { igst: 500, cgst: 0, sgst: 0 })
  check('credit left over carries to next month', so.carried.igst === 400 && tax(so.cash) === 0)

  // ── The books, with every document in them ───────────────────
  const company = await tx.company.findFirstOrThrow({ select: { id: true, gstin: true } })
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
  for (const [t, id] of docs) await postDocument(tx, t, id)
  // The month with the most invoices.
  const busiest = await tx.$queryRawUnsafe<Array<{ m: string }>>(`SELECT to_char("invoiceDate" + interval '330 minutes', 'YYYY-MM') AS m FROM ld_erp.sales_invoices GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)
  const month = busiest[0].m
  const from = `${month}-01`
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)

  // ── GSTR-1 ───────────────────────────────────────────────────
  const g = await gstr1(tx, from, to)
  const sumDocs = (list: typeof g.b2b) => r2(list.reduce((t, d) => t + d.rates.filter((x) => x.rate > 0).reduce((s, x) => s + x.taxable, 0), 0))
  const smallNet = r2(g.b2cs.reduce((t, r) => t + r.taxable, 0))
  const tables = r2(sumDocs(g.b2b) + sumDocs(g.b2cl) + smallNet - sumDocs(g.cdnr) - sumDocs(g.cdnur))
  check(`GSTR-1 ${month}: its tables add up to the net outward supply`, near(tables, g.totals.net.taxable), `${tables} / ${g.totals.net.taxable}`)
  const hsnTaxable = r2([...g.hsnB2b, ...g.hsnB2c].filter((h) => h.rate > 0).reduce((t, h) => t + h.taxable, 0))
  check('the HSN summary adds up to the same', near(hsnTaxable, g.totals.net.taxable), `${hsnTaxable}`)
  const json = gstr1Json(g)
  const jsonInvoices = (json.b2b ?? []).reduce((t: number, c: { inv: unknown[] }) => t + c.inv.length, 0)
  check('the portal file carries every B2B invoice, dated day-first', json.gstin === company.gstin && jsonInvoices === g.b2b.length && (!g.b2b.length || /^\d{2}-\d{2}-\d{4}$/.test((json.b2b as Array<{ inv: Array<{ idt: string }> }>)[0].inv[0].idt)), `${jsonInvoices} invoices`)
  const docsIssued = g.docs.invoices.reduce((t, s) => t + s.total, 0)
  const invoiceCount = await tx.salesInvoice.count({ where: { invoiceDate: { gte: new Date(`${from}T00:00:00+05:30`), lte: new Date(`${to}T23:59:59.999+05:30`) } } })
  check('documents issued counts every invoice, cancelled ones too', docsIssued === invoiceCount, `${docsIssued} / ${invoiceCount}`)

  // ── GSTR-3B against the ledgers ──────────────────────────────
  const b = await gstr3b(tx, from, to)
  check('3B tax on sales equals what the output GST ledgers took', near(tax(b.outward), tax(b.books.output)), `${tax(b.outward)} / ${tax(b.books.output)}`)
  const itc = tax(b.itc.net)
  check('3B input credit equals what the input GST ledgers took', near(itc, tax(b.books.input)), `${itc} / ${tax(b.books.input)}`)
  const s = b.setOff
  const covered = (h: 'igst' | 'cgst' | 'sgst') => r2(s.paid.igst[h] + (h === 'sgst' ? 0 : s.paid.cgst[h as 'igst' | 'cgst']) + (h === 'cgst' ? 0 : s.paid.sgst[h as 'igst' | 'sgst']) + s.cash[h])
  check('every rupee of tax is paid by credit or in cash', near(covered('igst'), s.liability.igst) && near(covered('cgst'), s.liability.cgst) && near(covered('sgst'), s.liability.sgst))

  // ── GSTR-2B ──────────────────────────────────────────────────
  const bills = await tx.purchaseInvoice.findMany({
    where: { status: { not: 'CANCELLED' }, supplierInvoiceNo: { not: null }, supplier: { gstin: { not: null } }, billDate: { gte: new Date(`${from}T00:00:00+05:30`), lte: new Date(`${to}T23:59:59.999+05:30`) } },
    take: 2,
    select: { supplierInvoiceNo: true, supplierInvoiceDate: true, billDate: true, taxableAmount: true, igst: true, cgst: true, sgst: true, supplier: { select: { gstin: true, name: true } } },
  })
  if (bills.length >= 2) {
    const inv = (x: (typeof bills)[number], bump = 0) => ({
      inum: x.supplierInvoiceNo,
      dt: '01-' + month.slice(5, 7) + '-' + month.slice(0, 4),
      val: Number(x.taxableAmount),
      txval: Number(x.taxableAmount),
      igst: Number(x.igst) + bump,
      cgst: Number(x.cgst),
      sgst: Number(x.sgst),
      itcavl: 'Y',
    })
    const file = {
      data: {
        docdata: {
          b2b: [
            { ctin: bills[0].supplier.gstin, trdnm: bills[0].supplier.name, inv: [inv(bills[0])] },
            { ctin: bills[1].supplier.gstin, trdnm: bills[1].supplier.name, inv: [inv(bills[1], 100)] },
            { ctin: '27ZZZZZ9999Z1Z5', trdnm: 'Not booked here', inv: [{ inum: 'NB-1', dt: '05-' + month.slice(5, 7) + '-' + month.slice(0, 4), val: 1000, txval: 1000, igst: 50, cgst: 0, sgst: 0 }] },
          ],
        },
      },
    }
    const m = await match2b(tx, read2b(file), from, to)
    const st = (n: string | null) => m.rows.find((r) => r.number === n)?.status
    check('an invoice the supplier filed as booked matches', st(bills[0].supplierInvoiceNo) === 'matched')
    check('one whose tax differs is flagged', st(bills[1].supplierInvoiceNo) === 'differs' && near(m.rows.find((r) => r.number === bills[1].supplierInvoiceNo)!.taxDiff ?? 0, 100))
    check('one filed but never booked is flagged', st('NB-1') === 'only-2b')
    check('bills booked that no supplier filed are listed', m.summary.onlyBooks >= 0 && m.rows.every((r) => r.status !== 'only-books' || !!r.bill))
  } else console.log('(fewer than two bills with a supplier GSTIN this month; 2B matching left unchecked)')
  let refused = ''
  try {
    read2b({ hello: 1 })
  } catch (e) {
    refused = (e as { code?: string }).code ?? ''
  }
  check('a file that is not GSTR-2B is refused', refused === 'NOT_2B')

  // ── TDS ──────────────────────────────────────────────────────
  check('TDS falls due on the 7th, and on 30 April for March', tdsDueDate('2026-10') === '2026-11-07' && tdsDueDate('2026-12') === '2027-01-07' && tdsDueDate('2026-03') === '2026-04-30')
  const fyFrom = '2026-04-01'
  const today = todayIst()
  // A bill with TDS on it, and part of that TDS paid in from Accounts.
  const section = await tx.tdsSection.findFirst({ where: { section: { startsWith: '194C' } }, select: { id: true, section: true } })
  const bill = await tx.purchaseInvoice.findFirst({
    where: { status: { not: 'CANCELLED' }, billDate: { gte: new Date(`${fyFrom}T00:00:00+05:30`) } },
    select: { id: true, taxableAmount: true, totalAmount: true, billDate: true, supplier: { select: { pan: true } } },
  })
  if (section && bill) {
    await tx.purchaseInvoice.update({ where: { id: bill.id }, data: { tdsAmount: 1000, tdsSectionId: section.id, tdsSection: section.section } })
    await postDocument(tx, 'PURCHASE_BILL', bill.id)
    const tdsLedger = await tx.ledger.findUniqueOrThrow({ where: { systemKey: `TDS_PAYABLE:${section.id}` }, select: { id: true } })
    const bank = await tx.ledger.findFirstOrThrow({ where: { partyType: 'BANK', isActive: true }, select: { id: true } })
    const user = await tx.user.findFirstOrThrow({ where: { status: 'ACTIVE' }, select: { id: true } })
    await writeVoucher(tx, voucherSchema.parse({ kind: 'PAYMENT', date: today, narration: 'TDS paid in', lines: [{ ledgerId: tdsLedger.id, side: 'DR', amount: 600 }, { ledgerId: bank.id, side: 'CR', amount: 600 }] }), user.id)
  }
  const t = await tdsDeducted(tx, fyFrom, today, today)
  if (section && bill) {
    const row = t.deducted.find((d) => d.from === 'PURCHASE_BILL' && d.tds === 1000)
    check("a bill's TDS shows under its section, on the bill's taxable value", row?.section === section.section && near(row.base ?? 0, Number(bill.taxableAmount)), `${row?.section} on ${row?.base}`)
    const sec = t.sections.find((x) => x.section === section.section)!
    const month = sec.months.find((m) => m.deducted >= 1000)
    check('what is paid in comes off the oldest month, and the rest is owed by the 7th', !!month && near(sec.paid, 600) && near(month.owing, month.deducted - 600) && month.due === tdsDueDate(month.month), JSON.stringify(month))
  } else console.log('(no 194C section or no bill this year; the TDS section check is left out)')
  const rangeY = { gte: new Date(`${fyFrom}T00:00:00+05:30`), lte: new Date(`${today}T23:59:59.999+05:30`) }
  const [billTds, payTds] = await Promise.all([
    tx.purchaseInvoice.aggregate({ where: { status: { not: 'CANCELLED' }, billDate: rangeY }, _sum: { tdsAmount: true } }),
    tx.supplierPayment.aggregate({ where: { status: 'POSTED', paymentDate: rangeY }, _sum: { tdsAmount: true } }),
  ])
  const fromDocs = r2(Number(billTds._sum.tdsAmount ?? 0) + Number(payTds._sum.tdsAmount ?? 0))
  const fromDocsInRegister = r2(t.deducted.filter((d) => d.from === 'PURCHASE_BILL' || d.from === 'SUPPLIER_PAYMENT').reduce((s2, d) => s2 + d.tds, 0))
  check('TDS deducted equals the TDS on the bills and payments', near(fromDocsInRegister, fromDocs), `${fromDocsInRegister} / ${fromDocs}`)
  check('each section owes what it took less what it paid in', t.sections.every((x) => near(x.closing, x.opening + x.deducted - x.paid)))
  const c = await tdsByCustomers(tx, fyFrom, today)
  const rcptTds = await tx.paymentReceiptAllocation.aggregate({ where: { receipt: { status: 'POSTED', receiptDate: rangeY } }, _sum: { tdsAmount: true } })
  check('TDS customers deducted equals the receipts\' TDS', near(c.total, Number(rcptTds._sum.tdsAmount ?? 0)), `${c.total}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
