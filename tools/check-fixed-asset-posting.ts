/**
 * Checks that a purchase bill for a fixed asset posts to the Fixed Assets
 * ledger of its sub-category, not to Purchases. Takes a bill already in the
 * demo database, files its first item under a fixed-asset sub-category, and
 * posts it — inside one transaction that always throws, so nothing is kept.
 * Demo database (lderp_demo) only. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" npx tsx ../../tools/check-fixed-asset-posting.ts
 */
import { prisma } from '../packages/database/src/index'
import { ensureChart } from '../apps/api/src/services/accounts/chart.service'
import { postDocument } from '../apps/api/src/services/accounts/posting.service'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 500)}` : ''}`)
}
class Rollback extends Error {}

async function main() {
  const [{ current_database: dbName }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (dbName !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  // The chart's own groups and ledgers, as the books keep them (demo only).
  await ensureChart(true)
  try {
    await prisma.$transaction(
      async (tx) => {
        const main = await tx.itemCategory.findFirstOrThrow({ where: { parentId: null, itemGroup: 'FIXED_ASSETS' }, select: { id: true } })
        const sub = await tx.itemCategory.create({ data: { name: `ZZTEST Posting Machines ${Date.now()}`, parentId: main.id, itemGroup: 'FIXED_ASSETS' }, select: { id: true, name: true } })
        const bill = await tx.purchaseInvoice.findFirst({
          where: { status: { not: 'CANCELLED' }, lines: { some: {} } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, lines: { select: { itemId: true }, take: 1 } },
        })
        if (!bill) { check('a bill to post', false); throw new Rollback() }
        await tx.item.update({ where: { id: bill.lines[0].itemId }, data: { categoryId: sub.id, type: 'FIXED_ASSET' } })
        const r = await postDocument(tx, 'PURCHASE_BILL', bill.id)
        check('the bill posts', r === 'created' || r === 'updated' || r === 'unchanged', r)
        const v = await tx.voucher.findFirst({ where: { sourceType: 'PURCHASE_BILL', sourceId: bill.id }, select: { lines: { select: { debit: true, ledger: { select: { name: true, systemKey: true, group: { select: { name: true } } } } } } } })
        const asset = v?.lines.find((l) => l.ledger.systemKey === `FIXED_ASSET_CAT:${sub.id}`)
        check('the machine is debited to its own Fixed Assets ledger', !!asset && Number(asset.debit) > 0, v?.lines.map((l) => [l.ledger.name, l.ledger.systemKey, Number(l.debit)]))
        check('named after its sub-category, under the Fixed Assets group', asset?.ledger.name === sub.name && /fixed assets/i.test(asset?.ledger.group?.name ?? ''), asset?.ledger)
        throw new Rollback()
      },
      { timeout: 120_000, maxWait: 20_000 },
    )
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
