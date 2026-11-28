/**
 * Phase 3 of the multi-brand plan: accounting dimensions.
 *
 * One set of books; income and expense lines carry two tags — the brand
 * (profit centre) and the department (cost centre) — and nothing else does.
 *
 *   - a purchase bill: an expense head's usual department; a brand and
 *     department picked on a line; goods bought for an indent take the
 *     indent's department and its MO's brand; freight is spread over the
 *     goods by value, each part with its line's tags; the supplier and tax
 *     lines carry none;
 *   - a line with no tag from its document takes its ledger's usual one, and
 *     posting again after the default changes rewrites the voucher;
 *   - sales sit with Sales & Marketing and the order's brand; job work with
 *     Production; a ledger's own default comes before that standard one;
 *   - a purchase note against a bill takes the bill's tags, spread the same way;
 *   - a manual journal takes a department on an expense line and refuses one
 *     on a party line;
 *   - across every voucher in the books, no bank, party or tax line is tagged;
 *   - the P&L by department and by brand each add up to the net profit, and
 *     the Unallocated Entries and Cost Centre Expenses reports agree.
 *
 * Everything inside one transaction that always throws: nothing is kept. Demo
 * database (lderp_demo) only. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   npx tsx ../../tools/check-phase3-dimensions.ts
 */
import { prisma } from '../packages/database/src/index'
import { ensureChart } from '../apps/api/src/services/accounts/chart.service'
import { booksSettings, todayIst, fyStartOf } from '../apps/api/src/services/accounts/books.service'
import { departmentNamed, postDocument, type SourceType } from '../apps/api/src/services/accounts/posting.service'
import { writeVoucher } from '../apps/api/src/services/accounts/voucher.service'
import { profitAndLoss } from '../apps/api/src/services/accounts/finalAccounts.service'
import { costCentreExpenses, unallocatedEntries } from '../apps/api/src/reports/definitions/accounts-dimensions'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 700)}` : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const stamp = Date.now().toString(36).slice(-5).toUpperCase()
const r2 = (n: number) => Math.round(n * 100) / 100
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** A voucher's lines, as tags and signed amounts (debit positive). */
async function linesOf(tx: Tx, sourceType: SourceType, sourceId: string) {
  const v = await tx.voucher.findUnique({
    where: { sourceType_sourceId: { sourceType, sourceId } },
    select: { id: true, status: true, lines: { select: { ledgerId: true, debit: true, credit: true, costCentreId: true, departmentId: true, ledger: { select: { name: true, systemKey: true, group: { select: { nature: true } } } } } } },
  })
  return (v?.lines ?? []).map((l) => ({
    ledgerId: l.ledgerId,
    ledger: l.ledger.name,
    key: l.ledger.systemKey,
    pl: l.ledger.group.nature === 'INCOME' || l.ledger.group.nature === 'EXPENSE',
    amount: r2(Number(l.debit) - Number(l.credit)),
    cc: l.costCentreId,
    dept: l.departmentId,
  }))
}

async function main() {
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== 'lderp_demo') {
    console.error('Refusing to run: not lderp_demo.')
    process.exitCode = 2
    return
  }
  const user = await prisma.user.findFirstOrThrow({ where: { role: { name: { in: ['Super Admin', 'Admin'] } } }, select: { id: true } })
  const traced = await prisma.purchaseOrderLine.findFirst({
    where: { mrLine: { mr: { moId: { not: null } } } },
    select: { id: true, itemId: true, mrLine: { select: { mr: { select: { mrNumber: true, departmentId: true, mo: { select: { moNumber: true, brandId: true } } } } } } },
  })
  const supplier = await prisma.supplier.findFirst({ where: { isActive: true }, select: { id: true } })
  const head = await prisma.item.findFirst({ where: { isActive: true, category: { OR: [{ name: { contains: 'xpense', mode: 'insensitive' } }, { parent: { name: { contains: 'xpense', mode: 'insensitive' } } }] } }, select: { id: true, name: true, categoryId: true, uomId: true } })
  const charge = await prisma.chargeType.findFirst({ where: { isActive: true }, select: { id: true, name: true } })
  const jobWorkInvoice = await prisma.salesInvoice.findFirst({ where: { so: { isJobWork: true }, status: { not: 'CANCELLED' } }, select: { id: true, invoiceNumber: true } })
  const ownInvoice = await prisma.salesInvoice.findFirst({ where: { so: { isJobWork: false }, status: { not: 'CANCELLED' } }, select: { id: true, invoiceNumber: true, so: { select: { brandId: true } } } })
  if (!traced?.mrLine?.mr.mo || !supplier || !head || !charge) throw new Error('demo data missing: a PO line for an indent of an MO, a supplier, an expense head, a charge type')

  // The chart made complete, as opening Accounts does: idempotent, outside the test's transaction.
  await ensureChart(true)
  try {
    await prisma.$transaction(
      async (tx) => {
        const s = await booksSettings(tx)
        if (!s.booksStart) throw new Error('the demo books have no start day')
        const today = todayIst()
        const refuses = async (label: string, run: () => Promise<unknown>, code: string) => {
          await tx.$executeRawUnsafe('SAVEPOINT refused')
          try {
            await run()
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT refused')
            check(label, false, 'was allowed')
          } catch (e) {
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refused')
            const err = e as { code?: string; message?: string }
            check(label, err.code === code, `${err.code}: ${err.message}`)
          }
        }

        // ── Who is who ──
        const deptAdmin = await departmentNamed(tx, 'Administration')
        const deptProd = await departmentNamed(tx, 'Production')
        const deptSales = await departmentNamed(tx, 'Sales & Marketing')
        const deptMaint = await departmentNamed(tx, 'Maintenance')
        if (!deptAdmin || !deptProd || !deptSales || !deptMaint) throw new Error('standard departments missing: press Cost centres on Masters → Departments')
        const other = await tx.costCentre.findFirstOrThrow({ where: { isActive: true, brand: { type: { not: 'CUSTOM' }, isDefault: false } }, select: { id: true, name: true } })
        const moCentre = (await tx.costCentre.findUnique({ where: { brandId: traced.mrLine.mr.mo.brandId }, select: { id: true } }))?.id ?? null
        const indentDept = traced.mrLine.mr.departmentId
        await tx.item.update({ where: { id: head.id }, data: { departmentId: deptAdmin } })
        const bare = await tx.item.create({ data: { code: `ZZP3H${stamp}`, name: `ZZTEST P3 repairs ${stamp}`, type: 'CONSUMABLE', categoryId: head.categoryId, uomId: head.uomId }, select: { id: true } })

        // ── 1. A bill: two expense lines, goods for an indent, freight spread over them ──
        const bill = await tx.purchaseInvoice.create({
          data: {
            billNumber: `ZZ-P3-${stamp}`,
            supplierId: supplier.id,
            billDate: new Date(`${today}T00:00:00Z`),
            subtotal: 8000,
            taxableAmount: 8000,
            totalAmount: 8800,
            balanceAmount: 8800,
            createdById: user.id,
            lines: {
              create: [
                { itemId: head.id, qty: 1, unitPrice: 1000, taxableValue: 1000, amount: 1000, sortOrder: 0 },
                { itemId: head.id, qty: 1, unitPrice: 3000, taxableValue: 3000, amount: 3000, sortOrder: 1, costCentreId: other.id, departmentId: deptProd },
                { itemId: traced.itemId, poLineId: traced.id, qty: 1, unitPrice: 4000, taxableValue: 4000, amount: 4000, sortOrder: 2 },
              ],
            },
            charges: { create: [{ chargeTypeId: charge.id, amount: 800 }] },
          },
          select: { id: true },
        })
        await postDocument(tx, 'PURCHASE_BILL', bill.id, user.id)
        let L = await linesOf(tx, 'PURCHASE_BILL', bill.id)
        const find = (pred: (l: (typeof L)[number]) => boolean) => L.filter(pred)
        const expense = find((l) => l.key === `EXPENSE:${head.id}`)
        check('the expense head line with nothing picked: its usual department, no brand (shared)', expense.some((l) => l.amount === 1000 && l.dept === deptAdmin && l.cc === null), expense)
        check('the expense line with a brand and department picked: exactly those', expense.some((l) => l.amount === 3000 && l.dept === deptProd && l.cc === other.id), expense)
        const goods = find((l) => l.pl && l.amount === 4000)
        check(`goods bought for ${traced.mrLine.mr.mrNumber}: the indent's department and ${traced.mrLine.mr.mo.moNumber}'s brand`, goods.length === 1 && goods[0].dept === indentDept && goods[0].cc === moCentre, goods)
        const freight = find((l) => l.key?.startsWith('PURCHASE_CHARGE:') ?? false).sort((a, b) => a.amount - b.amount)
        check('freight ₹800 spread by value: ₹100, ₹300 and ₹400, each with its line’s tags', freight.length === 3 && freight[0].amount === 100 && freight[0].dept === deptAdmin && freight[1].amount === 300 && freight[1].cc === other.id && freight[2].amount === 400 && freight[2].dept === indentDept, freight)
        const party = find((l) => !l.pl)
        check('the supplier line carries no tag', party.length > 0 && party.every((l) => l.cc === null && l.dept === null), party)
        check('the voucher balances', r2(L.reduce((t, l) => t + l.amount, 0)) === 0, L)

        // ── 2. Nothing from the document: the ledger's usual department, and posting again rewrites it ──
        const bill2 = await tx.purchaseInvoice.create({
          data: { billNumber: `ZZ-P3B-${stamp}`, supplierId: supplier.id, billDate: new Date(`${today}T00:00:00Z`), subtotal: 500, taxableAmount: 500, totalAmount: 500, balanceAmount: 500, createdById: user.id, lines: { create: [{ itemId: bare.id, qty: 1, unitPrice: 500, taxableValue: 500, amount: 500, sortOrder: 0 }] } },
          select: { id: true },
        })
        await postDocument(tx, 'PURCHASE_BILL', bill2.id, user.id)
        L = await linesOf(tx, 'PURCHASE_BILL', bill2.id)
        const bareLine = L.find((l) => l.key === `EXPENSE:${bare.id}`)!
        check('an expense head with no usual department: the line has none (it shows as unallocated)', !!bareLine && bareLine.dept === null, bareLine)
        const unalloc = (await unallocatedEntries.run({ tx, params: {}, rowCap: 5000 } as never)) as { rows: Array<Record<string, unknown>> }
        check('…and Unallocated Entries lists it, saying a department is missing', unalloc.rows.some((r) => r.voucherNo === `ZZ-P3B-${stamp}` && r.missing === 'DEPARTMENT'), unalloc.rows.slice(0, 3))
        await tx.ledger.update({ where: { id: bareLine.ledgerId }, data: { departmentId: deptMaint } })
        const again = await postDocument(tx, 'PURCHASE_BILL', bill2.id, user.id)
        L = await linesOf(tx, 'PURCHASE_BILL', bill2.id)
        check('given the ledger a usual department (Maintenance), posting again rewrites the line with it', again === 'updated' && L.some((l) => l.key === `EXPENSE:${bare.id}` && l.dept === deptMaint), [again, L])
        check('posting once more changes nothing', (await postDocument(tx, 'PURCHASE_BILL', bill2.id, user.id)) === 'unchanged')

        // ── 3. Sales: Sales & Marketing and the order's brand; job work with Production ──
        if (ownInvoice) {
          await postDocument(tx, 'SALES_INVOICE', ownInvoice.id, user.id)
          L = await linesOf(tx, 'SALES_INVOICE', ownInvoice.id)
          const sales = L.filter((l) => l.key === 'SALES')
          const soCentre = ownInvoice.so?.brandId ? (await tx.costCentre.findUnique({ where: { brandId: ownInvoice.so.brandId }, select: { id: true } }))?.id ?? null : null
          check(`${ownInvoice.invoiceNumber}: Sales with Sales & Marketing and the order's brand`, sales.length > 0 && sales.every((l) => l.dept === deptSales && l.cc === soCentre), sales)
          check(`${ownInvoice.invoiceNumber}: the customer, GST and round-off lines carry no tag`, L.filter((l) => !l.pl).every((l) => l.cc === null && l.dept === null), L)
          const salesLedger = sales[0]?.ledgerId
          if (salesLedger) {
            await tx.ledger.update({ where: { id: salesLedger }, data: { departmentId: deptAdmin } })
            await postDocument(tx, 'SALES_INVOICE', ownInvoice.id, user.id)
            L = await linesOf(tx, 'SALES_INVOICE', ownInvoice.id)
            check('a usual department on the Sales ledger comes before the standard one', L.filter((l) => l.key === 'SALES').every((l) => l.dept === deptAdmin), L)
            await tx.ledger.update({ where: { id: salesLedger }, data: { departmentId: null } })
            await postDocument(tx, 'SALES_INVOICE', ownInvoice.id, user.id)
          }
        } else check('a sales invoice of our own goods to post (none on the demo)', false)
        if (jobWorkInvoice) {
          await postDocument(tx, 'SALES_INVOICE', jobWorkInvoice.id, user.id)
          L = await linesOf(tx, 'SALES_INVOICE', jobWorkInvoice.id)
          const jw = L.filter((l) => l.pl && l.amount < 0)
          check(`${jobWorkInvoice.invoiceNumber} (job work): its income with Production`, jw.length > 0 && jw.every((l) => l.dept === deptProd), jw)
        } else check('a job-work invoice to post (none on the demo)', false)

        // ── 4. A purchase note against the bill takes the bill's tags, spread the same way ──
        const note = await tx.purchaseNote.create({
          data: {
            noteNumber: `ZZ-P3N-${stamp}`,
            reason: 'POST_PURCHASE_DISCOUNT',
            effect: 'REDUCES_PAYABLE',
            supplierId: supplier.id,
            billId: bill.id,
            noteDate: new Date(`${today}T00:00:00Z`),
            taxableAmount: 800,
            totalAmount: 800,
            status: 'POSTED',
            postedAt: new Date(),
            createdById: user.id,
          } as never,
          select: { id: true },
        })
        await postDocument(tx, 'PURCHASE_NOTE', note.id, user.id)
        L = await linesOf(tx, 'PURCHASE_NOTE', note.id)
        const back = L.filter((l) => l.key === 'PURCHASE_RETURNS').sort((a, b) => b.amount - a.amount)
        check('the note’s ₹800 comes off as the bill went: −₹100, −₹300 and −₹400, each with its line’s tags', back.length === 3 && back[0].amount === -100 && back[0].dept === deptAdmin && back[1].amount === -300 && back[1].cc === other.id && back[2].amount === -400 && back[2].dept === indentDept, back)

        // ── 5. A manual journal: a department on an expense line, never on a party line ──
        const supplierLedger = (await linesOf(tx, 'PURCHASE_BILL', bill.id)).find((l) => !l.pl)!.ledgerId
        const expenseLedger = expense[0].ledgerId
        const j = await writeVoucher(tx, { kind: 'JOURNAL', date: today, narration: 'ZZTEST P3 journal', lines: [{ ledgerId: expenseLedger, side: 'DR', amount: 250, departmentId: deptProd, costCentreId: other.id }, { ledgerId: supplierLedger, side: 'CR', amount: 250 }] } as never, user.id)
        const jl = await tx.voucherLine.findMany({ where: { voucherId: j.id }, select: { ledgerId: true, departmentId: true, costCentreId: true } })
        check('a journal: the expense line keeps its department and brand, the party line none', jl.some((l) => l.ledgerId === expenseLedger && l.departmentId === deptProd && l.costCentreId === other.id) && jl.some((l) => l.ledgerId === supplierLedger && !l.departmentId && !l.costCentreId), jl)
        await refuses(
          'a department on a party line is refused',
          () => writeVoucher(tx, { kind: 'JOURNAL', date: today, lines: [{ ledgerId: expenseLedger, side: 'DR', amount: 10 }, { ledgerId: supplierLedger, side: 'CR', amount: 10, departmentId: deptProd }] } as never, user.id),
          'DEPARTMENT_PL_ONLY',
        )

        // ── 6. Every document posted again: no bank, party or tax line tagged anywhere ──
        const docs: Array<{ t: SourceType; id: string }> = [
          ...(await tx.salesInvoice.findMany({ select: { id: true } })).map((d) => ({ t: 'SALES_INVOICE' as const, id: d.id })),
          ...(await tx.paymentReceipt.findMany({ select: { id: true } })).map((d) => ({ t: 'SALES_RECEIPT' as const, id: d.id })),
          ...(await tx.creditNote.findMany({ select: { id: true } })).map((d) => ({ t: 'CREDIT_NOTE' as const, id: d.id })),
          ...(await tx.purchaseInvoice.findMany({ select: { id: true } })).map((d) => ({ t: 'PURCHASE_BILL' as const, id: d.id })),
          ...(await tx.supplierPayment.findMany({ select: { id: true } })).map((d) => ({ t: 'SUPPLIER_PAYMENT' as const, id: d.id })),
          ...(await tx.purchaseNote.findMany({ select: { id: true } })).map((d) => ({ t: 'PURCHASE_NOTE' as const, id: d.id })),
        ]
        for (const d of docs) await postDocument(tx, d.t, d.id, user.id)
        const [bad] = await tx.$queryRaw<Array<{ n: number }>>`
          SELECT COUNT(*)::int AS n FROM ld_erp.acc_voucher_lines l
            JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
            JOIN ld_erp.ledgers led ON led.id = l."ledgerId" JOIN ld_erp.ledger_groups g ON g.id = led."groupId"
           WHERE v.status = 'POSTED' AND g.nature::text NOT IN ('INCOME', 'EXPENSE') AND (l."costCentreId" IS NOT NULL OR l."departmentId" IS NOT NULL)`
        check(`all ${docs.length} documents posted again: no bank, party or tax line carries a brand or department`, Number(bad.n) === 0, bad)
        const [unbalanced] = await tx.$queryRaw<Array<{ n: number }>>`
          SELECT COUNT(*)::int AS n FROM (SELECT v.id FROM ld_erp.acc_vouchers v JOIN ld_erp.acc_voucher_lines l ON l."voucherId" = v.id
           WHERE v.status = 'POSTED' GROUP BY v.id HAVING SUM(l.debit) <> SUM(l.credit)) x`
        check('every voucher still balances', Number(unbalanced.n) === 0, unbalanced)

        // ── 7. The P&L by department and by brand each add up; the expense report matches the books ──
        const pl = await profitAndLoss(tx, { from: fyStartOf(today, s.fyStartMonth), to: today }, s)
        const byDept = r2((pl.department ?? []).reduce((t, d) => t + d.netProfit, 0))
        const byBrand = r2(pl.brand.reduce((t, b) => t + b.netProfit, 0))
        check(`P&L: by department ₹${byDept} and by brand ₹${byBrand} both equal the net profit ₹${pl.netProfit}`, byDept === pl.netProfit && byBrand === pl.netProfit, [byDept, byBrand, pl.netProfit])
        check('P&L has a column for each department that carries something, and No department', (pl.deptColumns ?? []).some((c) => c.id === deptAdmin) && (pl.deptColumns ?? []).some((c) => c.id === ''), pl.deptColumns)
        const exp = (await costCentreExpenses.run({ tx, params: { from: fyStartOf(today, s.fyStartMonth), to: today }, rowCap: 5000 } as never)) as { rows: Array<{ amount: number }> }
        const [books] = await tx.$queryRaw<Array<{ amount: number }>>`
          SELECT COALESCE(SUM(l.debit - l.credit), 0)::float8 AS amount FROM ld_erp.acc_voucher_lines l
            JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
            JOIN ld_erp.ledgers led ON led.id = l."ledgerId" JOIN ld_erp.ledger_groups g ON g.id = led."groupId"
           WHERE v.status = 'POSTED' AND g.nature::text = 'EXPENSE'
             AND v.date >= ${new Date(`${fyStartOf(today, s.fyStartMonth)}T00:00:00+05:30`)} AND v.date <= ${new Date(`${today}T23:59:59.999+05:30`)}`
        const reportTotal = r2(exp.rows.reduce((t, r) => t + r.amount, 0))
        check(`Cost Centre Expenses adds up to the expenses in the books: ₹${reportTotal}`, reportTotal === r2(books.amount), [reportTotal, books.amount])

        throw ROLLBACK
      },
      { timeout: 900_000, maxWait: 30_000 },
    )
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
