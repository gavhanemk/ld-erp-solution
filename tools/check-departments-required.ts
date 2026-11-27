/**
 * Every new expense says which department bears it; legacy imports are let
 * in only on purpose, and marked. And a credit note takes its invoice's brand.
 *
 *   - an expense bill line with no department from any source is refused;
 *     picked on the line, or the expense head's usual one, it books;
 *   - a goods line (stock bought) needs none;
 *   - a manual voucher's expense line takes its ledger's usual department,
 *     and is refused when there is none;
 *   - a legacy import (bill or voucher) comes in without departments, marked,
 *     and is listed on Unallocated Entries as such;
 *   - a credit note's Sales Returns line carries its invoice's order's brand
 *     and Sales & Marketing.
 *
 * Inside one transaction that always throws: nothing is kept. Demo database
 * (lderp_demo) only. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   npx tsx ../../tools/check-departments-required.ts
 */
import { prisma } from '../packages/database/src/index'
import { ensureChart } from '../apps/api/src/services/accounts/chart.service'
import { todayIst } from '../apps/api/src/services/accounts/books.service'
import { departmentNamed, postDocument } from '../apps/api/src/services/accounts/posting.service'
import { voucherSchema, writeVoucher } from '../apps/api/src/services/accounts/voucher.service'
import { bookBill } from '../apps/api/src/routes/purchase.routes'
import { createBillSchema } from '../apps/api/src/schemas/bill.schemas'
import { unallocatedEntries } from '../apps/api/src/reports/definitions/accounts-dimensions'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 600)}` : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const stamp = Date.now().toString(36).slice(-5).toUpperCase()

async function main() {
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== 'lderp_demo') {
    console.error('Refusing to run: not lderp_demo.')
    process.exitCode = 2
    return
  }
  const user = await prisma.user.findFirstOrThrow({ where: { role: { name: { in: ['Super Admin', 'Admin'] } } }, select: { id: true } })
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { isActive: true }, select: { id: true } })
  const head = await prisma.item.findFirstOrThrow({ where: { isActive: true, category: { OR: [{ name: { contains: 'xpense', mode: 'insensitive' } }, { parent: { name: { contains: 'xpense', mode: 'insensitive' } } }] } }, select: { id: true, categoryId: true, uomId: true } })
  const goods = await prisma.item.findFirstOrThrow({ where: { isActive: true, type: 'RAW_MATERIAL', name: { startsWith: 'ZZTEST' } }, select: { id: true } })
  const note = await prisma.creditNote.findFirst({ where: { status: 'ISSUED', invoice: { so: { isNot: null } } }, select: { id: true, noteNumber: true, invoice: { select: { so: { select: { brandId: true } } } } } })
  await ensureChart(true)

  try {
    await prisma.$transaction(
      async (tx) => {
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
        const deptAdmin = (await departmentNamed(tx, 'Administration'))!
        const deptMaint = (await departmentNamed(tx, 'Maintenance'))!
        // A fresh expense head with no usual department, under the same category as the demo's.
        const bare = await tx.item.create({ data: { code: `ZZDRH${stamp}`, name: `ZZTEST DR repairs ${stamp}`, type: 'CONSUMABLE', categoryId: head.categoryId, uomId: head.uomId }, select: { id: true } })
        let n = 0
        const bill = (lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
          bookBill(
            tx,
            createBillSchema.parse({ supplierId: supplier.id, supplierInvoiceNo: `ZZDR-${stamp}-${++n}`, supplierInvoiceDate: `${today}T00:00:00Z`, billDate: `${today}T00:00:00Z`, lines: lines.map((l) => ({ qty: 1, unitPrice: 100, gstRate: 0, ...l })), ...extra }),
            user.id,
            true,
          )

        // ── Bills ──
        await refuses('an expense line with no department from anywhere is refused', () => bill([{ itemId: bare.id }]), 'DEPARTMENT_REQUIRED')
        const picked = await bill([{ itemId: bare.id, departmentId: deptAdmin }])
        await postDocument(tx, 'PURCHASE_BILL', picked.bill.id, user.id)
        const pv = await tx.voucher.findUnique({ where: { sourceType_sourceId: { sourceType: 'PURCHASE_BILL', sourceId: picked.bill.id } }, select: { lines: { select: { departmentId: true, ledger: { select: { systemKey: true } } } } } })
        check('with the department picked on the line it books, and its voucher line carries it', pv?.lines.some((l) => l.ledger.systemKey === `EXPENSE:${bare.id}` && l.departmentId === deptAdmin) ?? false, pv)
        await tx.item.update({ where: { id: bare.id }, data: { departmentId: deptMaint } })
        const usual = await bill([{ itemId: bare.id }])
        check('with a usual department on the expense head, nothing needs picking', !!usual.bill.id)
        const stock = await bill([{ itemId: goods.id }])
        check('a goods line (stock bought) needs no department', !!stock.bill.id)
        await tx.item.update({ where: { id: bare.id }, data: { departmentId: null } })
        const legacy = await bill([{ itemId: bare.id }], { legacyImport: { reason: 'ZZTEST brought in from the old books' } })
        const legacyRow = await tx.purchaseInvoice.findUnique({ where: { id: legacy.bill.id }, select: { legacyImport: true, billNumber: true } })
        check('a legacy import comes in without a department, marked as one', legacyRow?.legacyImport === true, legacyRow)
        await postDocument(tx, 'PURCHASE_BILL', legacy.bill.id, user.id)
        const un = (await unallocatedEntries.run({ tx, params: {}, rowCap: 5000 } as never)) as { rows: Array<Record<string, unknown>> }
        const row = un.rows.find((r) => r.voucherNo === legacyRow?.billNumber)
        check('…and Unallocated Entries lists it as a legacy import', !!row && /legacy import/.test(String(row.action)), row)

        // ── Manual vouchers ──
        const expense = await tx.ledger.create({ data: { name: `ZZTEST DR expense ${stamp}`, groupId: (await tx.ledgerGroup.findFirstOrThrow({ where: { systemKey: 'INDIRECT_EXPENSES' } })).id }, select: { id: true } })
        const partyLedger = await tx.ledger.findFirstOrThrow({ where: { supplierId: supplier.id }, select: { id: true } })
        const journal = (extra: Record<string, unknown> = {}) =>
          writeVoucher(tx, voucherSchema.parse({ kind: 'JOURNAL', date: today, narration: 'ZZTEST departments', lines: [{ ledgerId: expense.id, side: 'DR', amount: 50 }, { ledgerId: partyLedger.id, side: 'CR', amount: 50 }], ...extra }), user.id)
        await refuses('a journal’s expense line with no department and no usual one is refused', () => journal(), 'DEPARTMENT_REQUIRED')
        await tx.ledger.update({ where: { id: expense.id }, data: { departmentId: deptAdmin } })
        const j = await journal()
        const jl = await tx.voucherLine.findFirst({ where: { voucherId: j.id, ledgerId: expense.id }, select: { departmentId: true } })
        check('given the ledger a usual department, the expense line takes it by itself', jl?.departmentId === deptAdmin, jl)
        await tx.ledger.update({ where: { id: expense.id }, data: { departmentId: null } })
        const lj = await journal({ legacyImport: { reason: 'ZZTEST old books' } })
        const ljRow = await tx.voucher.findUnique({ where: { id: lj.id }, select: { legacyImport: true } })
        check('a legacy journal comes in without a department, marked', ljRow?.legacyImport === true, ljRow)

        // ── Credit notes inherit the invoice's brand ──
        if (note) {
          await postDocument(tx, 'CREDIT_NOTE', note.id, user.id)
          const cv = await tx.voucher.findUnique({ where: { sourceType_sourceId: { sourceType: 'CREDIT_NOTE', sourceId: note.id } }, select: { lines: { select: { costCentreId: true, departmentId: true, ledger: { select: { systemKey: true } } } } } })
          const centre = note.invoice?.so?.brandId ? (await tx.costCentre.findUnique({ where: { brandId: note.invoice.so.brandId }, select: { id: true } }))?.id : null
          const returns = cv?.lines.filter((l) => l.ledger.systemKey === 'SALES_RETURNS') ?? []
          const deptSales = await departmentNamed(tx, 'Sales & Marketing')
          check(`${note.noteNumber}: its Sales Returns carry the invoice's order's brand`, returns.length > 0 && !!centre && returns.every((l) => l.costCentreId === centre), returns)
          check(`${note.noteNumber}: and Sales & Marketing as their department`, returns.length > 0 && returns.every((l) => l.departmentId === deptSales), returns)
        } else check('a credit note against an invoice to post (none on the demo)', false)

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
