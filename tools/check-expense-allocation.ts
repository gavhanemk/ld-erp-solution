/**
 * Shared expenses split between the brands, month by month — and the
 * company's own figures never move.
 *
 *   - rules: fixed percentages must make 100%; stock purchases cannot be
 *     shared; typed percentages short of 100% stop the run;
 *   - the preview splits each shared amount by its rule — sales, fixed or
 *     typed shares — to the paisa, leaving brand-tagged and stock-purchase
 *     lines alone;
 *   - a draft is saved once a month (a second is refused, by the database
 *     too); discarded, the month is free again;
 *   - whoever worked it out does not approve it (an Admin may);
 *   - an expense booked after approval stops the posting until the run is
 *     worked out again;
 *   - posted: one journal on the month's last day; every ledger's, every
 *     department's and the company's totals unchanged; only the brand split
 *     moves; the P&L's net profit is the same;
 *   - reversed: a second journal puts the split back; the month runs again;
 *   - a closed period refuses the reversal; the current month cannot be
 *     posted before it ends.
 *
 * ZZTEST brands, ledgers and vouchers only, inside one transaction that
 * always throws: nothing is kept. Demo database (lderp_demo) only. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   npx tsx ../../tools/check-expense-allocation.ts
 */
import { prisma } from '../packages/database/src/index'
import { booksSettings, checkBalancedNow, dayValue, r2, todayIst } from '../apps/api/src/services/accounts/books.service'
import { departmentNamed, pendingDocuments, postDocument } from '../apps/api/src/services/accounts/posting.service'
import { profitAndLoss } from '../apps/api/src/services/accounts/finalAccounts.service'
import { approveRun, createRun, discardRun, markPosted, markReversed, reworkRun, workOut } from '../apps/api/src/services/accounts/allocation.service'
import { checkRule, ruleSchema } from '../apps/api/src/routes/allocation.routes'
import { unallocatedEntries } from '../apps/api/src/reports/definitions/accounts-dimensions'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 700)}` : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const stamp = Date.now().toString(36).slice(-5).toUpperCase()
const MONTH = '2026-10'

async function main() {
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== 'lderp_demo') {
    console.error('Refusing to run: not lderp_demo.')
    process.exitCode = 2
    return
  }
  const user = await prisma.user.findFirstOrThrow({ where: { role: { name: { in: ['Super Admin', 'Admin'] } } }, select: { id: true } })
  const other = await prisma.user.findFirst({ where: { id: { not: user.id } }, select: { id: true } })
  const company = await prisma.company.findFirstOrThrow({ select: { id: true } })

  try {
    await prisma.$transaction(
      async (tx) => {
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

        // ── The books open from October, unlocked, for this test alone ──
        const s0 = await booksSettings(tx)
        if (!s0.booksStart || s0.booksStart > `${MONTH}-01`) await tx.company.update({ where: { id: company.id }, data: { booksStartDate: dayValue(`${MONTH}-01`) } })
        await tx.company.update({ where: { id: company.id }, data: { booksLockedUpTo: null } })

        // ── Three own ZZTEST brands, each with its profit centre ──
        const brand = async (tag: string) => {
          const b = await tx.brand.create({ data: { companyId: company.id, name: `ZZTEST AL ${tag} ${stamp}`, type: 'LD_COTTON_MILLS' }, select: { id: true } })
          return (await tx.costCentre.create({ data: { name: `ZZTEST AL ${tag} ${stamp}`, brandId: b.id }, select: { id: true } })).id
        }
        const A = await brand('A')
        const B = await brand('B')
        const C = await brand('C')

        // ── Ledgers ──
        const group = (systemKey: string) => tx.ledgerGroup.findFirstOrThrow({ where: { systemKey }, select: { id: true } }).then((g) => g.id)
        const ledger = (name: string, groupId: string) => tx.ledger.create({ data: { name: `ZZTEST AL ${name} ${stamp}`, groupId }, select: { id: true } }).then((l) => l.id)
        const indirect = await group('INDIRECT_EXPENSES')
        const power = await ledger('power', indirect)
        const rent = await ledger('rent', indirect)
        const misc = await ledger('misc', indirect)
        const sales = await ledger('sales', await group('SALES_ACCOUNTS'))
        const purchases = await ledger('purchases', await group('PURCHASE_ACCOUNTS'))
        const liabilityGroup = (await tx.ledgerGroup.findFirstOrThrow({ where: { nature: 'LIABILITY' }, select: { id: true } })).id
        const party = await ledger('party', liabilityGroup)
        const admin = (await departmentNamed(tx, 'Administration'))!
        const maint = (await departmentNamed(tx, 'Maintenance'))!

        let vn = 0
        const jv = async (day: string, lines: Array<{ ledgerId: string; amount: number; costCentreId?: string | null; departmentId?: string | null }>) => {
          const all = [...lines, { ledgerId: party, amount: -r2(lines.reduce((t, l) => t + l.amount, 0)) }]
          const v = await tx.voucher.create({
            data: {
              kind: 'JOURNAL',
              voucherNo: `ZZAL${stamp}${++vn}`,
              financialYear: '2627',
              date: dayValue(day),
              narration: 'ZZTEST allocation',
              amount: r2(all.filter((l) => l.amount > 0).reduce((t, l) => t + l.amount, 0)),
              createdById: user.id,
              lines: {
                create: all.map((l, i) => ({
                  ledgerId: l.ledgerId,
                  debit: l.amount > 0 ? l.amount : 0,
                  credit: l.amount < 0 ? -l.amount : 0,
                  costCentreId: ('costCentreId' in l ? l.costCentreId : null) ?? null,
                  departmentId: ('departmentId' in l ? l.departmentId : null) ?? null,
                  sortOrder: i,
                })),
              },
            },
            select: { id: true },
          })
          await checkBalancedNow(tx)
          return v.id
        }

        // October: sales by brand (60 / 40 / none), shared expenses, one rent line already on a brand, stock bought.
        await jv(`${MONTH}-05`, [{ ledgerId: sales, amount: -60000, costCentreId: A, departmentId: null }, { ledgerId: sales, amount: -40000, costCentreId: B, departmentId: null }])
        await jv(`${MONTH}-10`, [{ ledgerId: power, amount: 10000, departmentId: maint }])
        await jv(`${MONTH}-20`, [{ ledgerId: power, amount: 2345.67, departmentId: maint }])
        await jv(`${MONTH}-15`, [{ ledgerId: rent, amount: 30000, departmentId: admin }])
        await jv(`${MONTH}-16`, [{ ledgerId: rent, amount: 999.99, departmentId: admin, costCentreId: A }])
        await jv(`${MONTH}-18`, [{ ledgerId: misc, amount: 500, departmentId: admin }])
        await jv(`${MONTH}-19`, [{ ledgerId: purchases, amount: 5000 }])

        // ── Rules ──
        const rule = (r: Record<string, unknown>) => ruleSchema.parse(r)
        await refuses(
          'fixed percentages that make 99.99% are refused',
          () => checkRule(tx, rule({ name: 'ZZTEST bad', basis: 'FIXED_PERCENT', ledgerIds: [rent], costCentreIds: [A, B], shares: [{ costCentreId: A, percent: 50 }, { costCentreId: B, percent: 49.99 }] })),
          'NOT_100',
        )
        await refuses('a stock-purchase ledger cannot be shared', () => checkRule(tx, rule({ name: 'ZZTEST bad 2', basis: 'REVENUE', ledgerIds: [purchases], costCentreIds: [A, B] })), 'BAD_LEDGER')
        const make = async (r: Record<string, unknown>) => {
          const p = rule(r)
          await checkRule(tx, p)
          const { shares, ...data } = p
          return (await tx.allocationRule.create({ data: { ...data, createdById: user.id, shares: { create: shares } }, select: { id: true } })).id
        }
        const rPower = await make({ name: `ZZTEST AL power by sales ${stamp}`, basis: 'REVENUE', ledgerIds: [power], costCentreIds: [A, B, C], sortOrder: 1 })
        await make({ name: `ZZTEST AL rent fixed ${stamp}`, basis: 'FIXED_PERCENT', ledgerIds: [rent], departmentIds: [admin], costCentreIds: [A, B, C], shares: [{ costCentreId: A, percent: 33.3333 }, { costCentreId: B, percent: 33.3333 }, { costCentreId: C, percent: 33.3334 }], sortOrder: 2 })
        const rMisc = await make({ name: `ZZTEST AL misc typed ${stamp}`, basis: 'MANUAL', ledgerIds: [misc], costCentreIds: [A, B], sortOrder: 3 })
        check('rules with 100% shares and shared ledgers are saved', !!rPower && !!rMisc)

        // ── Preview ──
        const half = { [rMisc]: { [A]: 50, [B]: 50 } }
        const w = await workOut(tx, MONTH, half)
        const mine = (ledgerId: string) => w.lines.find((l) => l.ledgerId === ledgerId)
        const split = (ledgerId: string, centre: string) => mine(ledgerId)?.splits.find((x) => x.costCentreId === centre)?.amount ?? 0
        check('power (₹12,345.67) splits by sales: 60% to A = ₹7,407.40, 40% to B = ₹4,938.27, nothing to C', split(power, A) === 7407.4 && split(power, B) === 4938.27 && split(power, C) === 0, mine(power))
        check('rent (₹30,000) at 33.3333 / 33.3333 / 33.3334: ₹9,999.99 + ₹9,999.99 + ₹10,000.02', split(rent, A) === 9999.99 && split(rent, B) === 9999.99 && split(rent, C) === 10000.02, mine(rent))
        check('misc (₹500) at the typed 50 / 50', split(misc, A) === 250 && split(misc, B) === 250, mine(misc))
        check('every shared amount’s parts add up to it, to the paisa', w.lines.every((l) => r2(l.splits.reduce((t, x) => t + x.amount, 0)) === r2(l.sharedAmount)), w.lines)
        check('the rent already on brand A (₹999.99) is not shared', mine(rent)?.sharedAmount === 30000, mine(rent))
        check('stock bought is not a shared expense', !w.sources.some((x) => x.ledgerId === purchases) && !w.notCovered.some((x) => x.ledgerId === purchases))
        check('each rule’s shares make 100%', w.rules.filter((r) => r.covers).every((r) => Math.abs(r.shares.reduce((t, x) => t + x.percent, 0) - 100) < 1e-6), w.rules)

        // ── Typed shares short of 100% stop the run ──
        await refuses('typed percentages making 90% are refused', () => createRun(tx, MONTH, { [rMisc]: { [A]: 50, [B]: 40 } }, null, user.id), 'ALLOCATION_PROBLEM')

        // ── One live run a month ──
        const first = await createRun(tx, MONTH, half, 'ZZTEST', user.id)
        check(`a draft is saved: ${first.runNumber}`, /^ALC-\d{4}-\d{4}$/.test(first.runNumber), first.runNumber)
        await refuses('a second run of the month is refused', () => createRun(tx, MONTH, half, null, user.id), 'RUN_EXISTS')
        await refuses('…and the database refuses one too', () => tx.allocationRun.create({ data: { runNumber: `ZZDUP${stamp}`, period: MONTH } }), 'P2002')
        await discardRun(tx, first.id, 'ZZTEST set aside')
        const run = await createRun(tx, MONTH, half, null, user.id)
        check('discarded, the month is free to run again', !!run.id && run.runNumber !== first.runNumber)

        // ── Approval by someone else ──
        await refuses('whoever worked it out does not approve it', () => approveRun(tx, run.id, user.id, false), 'SELF_APPROVAL')
        if (other) await approveRun(tx, run.id, other.id, false)
        else await approveRun(tx, run.id, user.id, true)
        check('approved by someone else', (await tx.allocationRun.findUnique({ where: { id: run.id } }))?.status === 'APPROVED')

        // ── An expense booked after approval stops the posting ──
        await jv(`${MONTH}-28`, [{ ledgerId: power, amount: 100, departmentId: maint }])
        await refuses('a power bill booked after approval stops the posting', () => markPosted(tx, run.id, user.id), 'RUN_OUT_OF_DATE')
        await reworkRun(tx, run.id, undefined, user.id)
        const back = await tx.allocationRun.findUnique({ where: { id: run.id } })
        check('worked out again, it is a draft needing approval afresh', back?.status === 'DRAFT' && back.approvedById === null, back?.status)
        await approveRun(tx, run.id, user.id, true)
        check('an Admin may approve their own', (await tx.allocationRun.findUnique({ where: { id: run.id } }))?.status === 'APPROVED')

        // ── Posting: the company's figures do not move ──
        const { gte, lte } = { gte: new Date(`${MONTH}-01T00:00:00+05:30`), lte: new Date(`${MONTH}-31T23:59:59.999+05:30`) }
        const totals = async (by: string) =>
          Object.fromEntries(
            (
              await tx.$queryRawUnsafe<Array<{ k: string; amt: number }>>(
                `SELECT COALESCE(${by}, '') AS k, SUM(l.debit - l.credit)::float8 AS amt
                   FROM ld_erp.acc_voucher_lines l JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
                  WHERE v.status = 'POSTED' AND v.date >= $1 AND v.date <= $2 GROUP BY 1 ORDER BY 1`,
                gte,
                lte,
              )
            ).map((r) => [r.k, r2(r.amt)]),
          )
        const myBrands = async () =>
          Object.fromEntries(
            (
              await tx.$queryRawUnsafe<Array<{ k: string; amt: number }>>(
                `SELECT COALESCE(l."costCentreId", 'none') AS k, SUM(l.debit - l.credit)::float8 AS amt
                   FROM ld_erp.acc_voucher_lines l JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
                  WHERE v.status = 'POSTED' AND l."ledgerId" = ANY($1::text[]) GROUP BY 1`,
                [power, rent, misc],
              )
            ).map((r) => [r.k, r2(r.amt)]),
          )
        const pl = async () => {
          const p = await profitAndLoss(tx, { from: `${MONTH}-01`, to: `${MONTH}-31` }, await booksSettings(tx))
          return { net: p.netProfit, depts: Object.fromEntries(p.department.map((d) => [d.id, d.netProfit])), brands: Object.fromEntries(p.brand.map((b) => [b.id, b.netProfit])) }
        }
        const ledgersBefore = await totals('l."ledgerId"')
        const deptsBefore = await totals('l."departmentId"')
        const brandsBefore = await myBrands()
        const plBefore = await pl()

        await markPosted(tx, run.id, user.id)
        const posted = await postDocument(tx, 'EXPENSE_ALLOCATION', run.id, user.id)
        const jvRow = await tx.voucher.findUnique({ where: { sourceType_sourceId: { sourceType: 'EXPENSE_ALLOCATION', sourceId: run.id } }, select: { voucherNo: true, kind: true, date: true, lines: { select: { costCentreId: true } } } })
        check(`posted as journal ${run.runNumber}, dated 31 Oct`, posted === 'created' && jvRow?.voucherNo === run.runNumber && jvRow.kind === 'JOURNAL' && jvRow.date.toISOString().startsWith(`${MONTH}-31`), { posted, jvRow })

        const ledgersAfter = await totals('l."ledgerId"')
        const deptsAfter = await totals('l."departmentId"')
        const brandsAfter = await myBrands()
        const plAfter = await pl()
        check('every ledger’s total for October is unchanged', JSON.stringify(ledgersAfter) === JSON.stringify(ledgersBefore))
        check('every department’s total for October is unchanged', JSON.stringify(deptsAfter) === JSON.stringify(deptsBefore))
        check('the company’s net profit is unchanged', plAfter.net === plBefore.net, { before: plBefore.net, after: plAfter.net })
        check('each department’s net profit is unchanged', JSON.stringify(plAfter.depts) === JSON.stringify(plBefore.depts))
        const expectA = r2(7467.4 + 9999.99 + 250 + 999.99)
        const expectB = r2(4978.27 + 9999.99 + 250)
        check(
          `the brand split moves: A ₹${expectA}, B ₹${expectB}, C ₹10,000.02, nothing left shared`,
          brandsAfter[A] === expectA && brandsAfter[B] === expectB && brandsAfter[C] === 10000.02 && (brandsAfter.none ?? 0) === 0,
          { brandsBefore, brandsAfter },
        )
        check('the P&L’s brand profits move by the same amounts', r2(plBefore.brands[A] - plAfter.brands[A]) === r2(expectA - 999.99) && r2(plAfter.brands[''] - plBefore.brands['']) === r2(expectA - 999.99 + expectB + 10000.02), { before: plBefore.brands, after: plAfter.brands })

        await refuses('a posted month cannot be run again', () => createRun(tx, MONTH, half, null, user.id), 'RUN_EXISTS')
        await refuses('a posted run is reversed, not discarded', () => discardRun(tx, run.id, 'ZZTEST try'), 'NOT_DISCARDABLE')
        const un = (await unallocatedEntries.run({ tx, params: { from: `${MONTH}-01`, to: `${MONTH}-31` }, rowCap: 5000 } as never)) as { rows: Array<Record<string, unknown>> }
        check('the journal’s lines are not “unallocated entries”', !un.rows.some((r) => String(r.voucherNo ?? '').startsWith('ALC-')))

        // ── Reversal ──
        await tx.company.update({ where: { id: company.id }, data: { booksLockedUpTo: dayValue(`${MONTH}-31`) } })
        await refuses('with October closed, the reversal is refused', async () => {
          await markReversed(tx, run.id, 'ZZTEST closed', user.id)
          await postDocument(tx, 'EXPENSE_ALLOCATION_REVERSAL', run.id, user.id)
        }, 'PERIOD_LOCKED')
        await tx.company.update({ where: { id: company.id }, data: { booksLockedUpTo: null } })
        await markReversed(tx, run.id, 'ZZTEST bills came late', user.id)
        const reversed = await postDocument(tx, 'EXPENSE_ALLOCATION_REVERSAL', run.id, user.id)
        const rv = await tx.voucher.findUnique({ where: { sourceType_sourceId: { sourceType: 'EXPENSE_ALLOCATION_REVERSAL', sourceId: run.id } }, select: { voucherNo: true } })
        const brandsBack = await myBrands()
        check(`reversed by journal ${run.runNumber}-R, the original kept`, reversed === 'created' && rv?.voucherNo === `${run.runNumber}-R` && !!(await tx.voucher.findUnique({ where: { sourceType_sourceId: { sourceType: 'EXPENSE_ALLOCATION', sourceId: run.id } } })))
        check('the brand split is back as it was', JSON.stringify(Object.entries(brandsBack).filter(([, v]) => v !== 0).sort()) === JSON.stringify(Object.entries(brandsBefore).filter(([, v]) => v !== 0).sort()), { brandsBefore, brandsBack })
        check('ledgers and departments still unchanged', JSON.stringify(await totals('l."ledgerId"')) === JSON.stringify(ledgersBefore) && JSON.stringify(await totals('l."departmentId"')) === JSON.stringify(deptsBefore))

        // ── The month runs again ──
        const again = await createRun(tx, MONTH, half, null, user.id)
        await approveRun(tx, again.id, user.id, true)
        await markPosted(tx, again.id, user.id)
        await postDocument(tx, 'EXPENSE_ALLOCATION', again.id, user.id)
        const brandsAgain = await myBrands()
        check(`run again as ${again.runNumber}: the same split as the first`, JSON.stringify(Object.entries(brandsAgain).sort()) === JSON.stringify(Object.entries(brandsAfter).sort()), { brandsAfter, brandsAgain })
        const pend = await pendingDocuments(tx)
        check('nothing of allocation waits to be posted', !pend.pending.some((p) => p.sourceType.startsWith('EXPENSE_ALLOCATION')), pend.pending.filter((p) => p.sourceType.startsWith('EXPENSE_ALLOCATION')))

        // ── The month in progress cannot be posted before it ends ──
        const today = todayIst()
        const thisMonth = today.slice(0, 7)
        const lastDay = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)), 0)).toISOString().slice(0, 10)
        if (today < lastDay) {
          await jv(today, [{ ledgerId: misc, amount: 500, departmentId: admin }])
          const now = await createRun(tx, thisMonth, half, null, user.id)
          await approveRun(tx, now.id, user.id, true)
          await refuses(`${thisMonth} is not over: its run is not posted yet`, () => markPosted(tx, now.id, user.id), 'MONTH_NOT_OVER')
        } else check('(today is the month’s last day: nothing to hold back)', true)

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
