/**
 * Phase 0 of the multi-brand plan: the guards that come before any brand work.
 *
 *   - a save sent twice with the same request id saves once: transfer,
 *     stock-in, count, job-work challan, FG receipt, manual voucher;
 *   - two transfers going opposite ways at the same moment both finish;
 *   - two requisitions reserving the same free stock at the same moment
 *     cannot both hold it;
 *   - every stock row says who wrote it;
 *   - the database refuses a voucher whose debits and credits differ.
 *
 * Runs against a running API and the demo database (lderp_demo) only, and
 * refuses any other database. Everything it makes is cancelled, rejected or
 * closed again at the end. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-phase0-guards.ts
 */
import { randomUUID } from 'node:crypto'
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5105/api').replace(/\/+$/, '')
let pass = 0
let fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 500)}` : ''}`)
}
type Res = { status: number; body: any }
let token = ''
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let j: any = null
  try {
    j = await r.json()
  } catch {}
  return { status: r.status, body: j }
}
const okay = (r: Res) => r.status >= 200 && r.status < 300
const rid = () => randomUUID()

async function bookQty(itemId: string, warehouseId: string): Promise<number> {
  const [r] = await prisma.$queryRaw<{ q: number }[]>`
    SELECT COALESCE(SUM("inQty" - "outQty"), 0)::float8 AS q FROM ld_erp.stock_ledger
    WHERE "itemId" = ${itemId} AND "warehouseId" = ${warehouseId} AND ownership::text = 'OWNED' AND grade = 'A' AND "sizeId" IS NULL`
  return Math.round(Number(r?.q ?? 0) * 1000) / 1000
}

async function main() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) {
    console.error('Set E2E_EMAIL and E2E_PASSWORD.')
    process.exitCode = 2
    return
  }
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== 'lderp_demo') {
    console.error('Refusing to run: not lderp_demo.')
    process.exitCode = 2
    return
  }
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.json())
  token = login.accessToken
  const me: string = login.user?.id
  if (!token || !me) throw new Error('login failed')

  const cleanups: Array<() => Promise<unknown>> = []
  try {
    // An item of ours, grade A, with whole units free in a general store, and
    // a second general store holding none of it (so moving back and forth
    // cannot blend two averages).
    const candidates = await prisma.$queryRaw<Array<{ itemId: string; warehouseId: string; qty: number }>>`
      SELECT s."itemId", s."warehouseId", SUM(s."inQty" - s."outQty")::float8 AS qty
      FROM ld_erp.stock_ledger s
      JOIN ld_erp.warehouses w ON w.id = s."warehouseId"
      JOIN ld_erp.items i ON i.id = s."itemId"
      WHERE s.ownership::text = 'OWNED' AND s.grade = 'A' AND s."sizeId" IS NULL
        AND w."isActive" AND w."departmentId" IS NULL AND w.purpose::text = 'GENERAL' AND i."isActive"
        AND NOT EXISTS (SELECT 1 FROM ld_erp.stock_reservations r WHERE r."itemId" = s."itemId" AND r.status::text = 'ACTIVE')
        AND NOT EXISTS (SELECT 1 FROM ld_erp.stock_packages p WHERE p."itemId" = s."itemId" AND p.status::text = 'IN_STOCK')
      GROUP BY s."itemId", s."warehouseId"
      HAVING SUM(s."inQty" - s."outQty") >= 6
      ORDER BY SUM(s."inQty" - s."outQty") DESC
      LIMIT 30`
    let pick: { itemId: string; a: string; b: string } | null = null
    for (const c of candidates) {
      const other = await prisma.$queryRaw<{ id: string }[]>`
        SELECT w.id FROM ld_erp.warehouses w
        WHERE w."isActive" AND w."departmentId" IS NULL AND w.purpose::text = 'GENERAL' AND w.id <> ${c.warehouseId}
          AND NOT EXISTS (SELECT 1 FROM ld_erp.stock_ledger s WHERE s."itemId" = ${c.itemId} AND s."warehouseId" = w.id)
        ORDER BY w.name LIMIT 1`
      if (other[0]) {
        pick = { itemId: c.itemId, a: c.warehouseId, b: other[0].id }
        break
      }
    }
    if (!pick) throw new Error('No item with free stock in a general store and an empty second store on the demo database')
    const { itemId, a, b } = pick
    const startA = await bookQty(itemId, a)
    console.log(`Using item ${itemId}: ${startA} in store ${a}, none in ${b}`)

    // ── 1. A transfer sent twice saves once, and its rows say who moved it ──
    const t1 = rid()
    const tBody = { requestId: t1, fromWarehouseId: a, toWarehouseId: b, notes: 'ZZTEST phase 0: repeat', lines: [{ itemId, qty: 1 }] }
    const tr1 = await call('POST', '/inventory/transfers', tBody)
    const tr2 = await call('POST', '/inventory/transfers', tBody)
    check('transfer: first save made it', tr1.status === 201 && tr1.body?.repeat === false, tr1)
    check('transfer: the repeat gets the same transfer back', tr2.status === 200 && tr2.body?.repeat === true && tr2.body?.data?.id === tr1.body?.data?.id, tr2)
    check('transfer: stock moved once', (await bookQty(itemId, a)) === startA - 1 && (await bookQty(itemId, b)) === 1)
    if (okay(tr1)) cleanups.push(() => call('PATCH', `/inventory/transfers/${tr1.body.data.id}/cancel`, { reason: 'ZZTEST phase 0 clean-up' }))
    const rows = await prisma.stockLedger.findMany({ where: { referenceId: tr1.body?.data?.id }, select: { createdById: true } })
    check('transfer: both stock rows say who moved it', rows.length === 2 && rows.every((r) => r.createdById === me), rows)

    // ── 2. Two transfers going opposite ways at once both finish ──
    const pairs: Res[] = []
    for (let round = 0; round < 3; round++) {
      const [x, y] = await Promise.all([
        call('POST', '/inventory/transfers', { requestId: rid(), fromWarehouseId: a, toWarehouseId: b, notes: 'ZZTEST phase 0: both ways', lines: [{ itemId, qty: 1 }] }),
        call('POST', '/inventory/transfers', { requestId: rid(), fromWarehouseId: b, toWarehouseId: a, notes: 'ZZTEST phase 0: both ways', lines: [{ itemId, qty: 1 }] }),
      ])
      pairs.push(x, y)
      for (const r of [x, y]) if (okay(r)) cleanups.push(() => call('PATCH', `/inventory/transfers/${r.body.data.id}/cancel`, { reason: 'ZZTEST phase 0 clean-up' }))
    }
    check('opposite transfers at the same moment: all six finished', pairs.every((r) => r.status === 201), pairs.filter((r) => r.status !== 201).map((r) => r.body?.message))
    check('opposite transfers: store totals add up', (await bookQty(itemId, a)) + (await bookQty(itemId, b)) === startA)

    // ── 3. A stock-in sent twice saves once ──
    const s1 = rid()
    const sBody = { requestId: s1, warehouseId: a, source: 'FOUND', notes: 'ZZTEST phase 0', lines: [{ itemId, qty: 1, unitRate: 10 }] }
    const si1 = await call('POST', '/inventory/stock-in', sBody)
    const si2 = await call('POST', '/inventory/stock-in', sBody)
    check('stock-in: the repeat gets the same document back', si1.status === 201 && si2.status === 200 && si2.body?.repeat === true && si2.body?.data?.id === si1.body?.data?.id, [si1.status, si2.status, si2.body?.message])
    if (okay(si1)) cleanups.push(() => call('POST', `/inventory/adjustments/${si1.body.data.id}/reject`, { reason: 'ZZTEST phase 0 clean-up' }))

    // ── 4. A count sent twice saves once ──
    const book = await bookQty(itemId, a)
    const c1 = rid()
    const cBody = { requestId: c1, warehouseId: a, reason: 'ZZTEST phase 0: repeat count', lines: [{ itemId, countedQty: book }] }
    const co1 = await call('POST', '/inventory/adjustments', cBody)
    const co2 = await call('POST', '/inventory/adjustments', cBody)
    check('count: the repeat gets the same count back', co1.status === 201 && co2.status === 200 && co2.body?.repeat === true && co2.body?.data?.id === co1.body?.data?.id, [co1.status, co1.body?.message, co2.status])
    const sameNumber = co1.body?.data?.adjustmentNumber ? await prisma.stockAdjustment.count({ where: { adjustmentNumber: co1.body.data.adjustmentNumber } }) : -1
    check('count: one document only', sameNumber === 1, sameNumber)

    // ── 5. A job-work challan sent twice goes out once ──
    const worker = await prisma.supplier.findFirst({ where: { isActive: true }, select: { id: true } })
    if (worker) {
      const j1 = rid()
      const jBody = { requestId: j1, jobWorkerId: worker.id, process: 'ZZTEST phase 0 stitching', fromWarehouseId: a, toWarehouseId: b, notes: 'ZZTEST phase 0', lines: [{ itemId, qty: 1 }] }
      const jw1 = await call('POST', '/inventory/job-work', jBody)
      const jw2 = await call('POST', '/inventory/job-work', jBody)
      check('job-work challan: the repeat gets the same challan back', jw1.status === 201 && jw2.status === 200 && jw2.body?.repeat === true && jw2.body?.data?.id === jw1.body?.data?.id, [jw1.status, jw1.body?.message, jw2.status])
      if (okay(jw1)) cleanups.push(() => call('PATCH', `/inventory/job-work/${jw1.body.data.id}/cancel`, { reason: 'ZZTEST phase 0 clean-up' }))
    } else {
      check('job-work challan: a supplier to send to', false, 'no active supplier on the demo database')
    }

    // ── 6. An FG receipt sent twice comes in once ──
    const fgStore = await prisma.warehouse.findFirst({ where: { isActive: true, departmentId: null, purpose: 'GENERAL' }, orderBy: { name: 'asc' }, select: { id: true } })
    const fgItem =
      (await prisma.item.findFirst({
        where: { isActive: true, type: 'FINISHED_GOOD', standardRate: { gt: 0 }, styleId: null, NOT: { name: { contains: 'VHAGAR', mode: 'insensitive' } } },
        select: { id: true },
      })) ??
      (await prisma.item.findFirst({
        where: { isActive: true, type: 'FINISHED_GOOD', standardRate: { gt: 0 }, name: { startsWith: 'ZZTEST' } },
        select: { id: true },
      }))
    if (fgStore && fgItem) {
      const f1 = rid()
      const fBody = { requestId: f1, warehouseId: fgStore.id, notes: 'ZZTEST phase 0', lines: [{ itemId: fgItem.id, sizeId: null, qty: 1, grade: 'A' }] }
      const fg1 = await call('POST', '/finished-goods', fBody)
      const fg2 = await call('POST', '/finished-goods', fBody)
      check('FG receipt: the repeat gets the same receipt back', fg1.status === 201 && fg2.status === 200 && fg2.body?.repeat === true && fg2.body?.data?.id === fg1.body?.data?.id, [fg1.status, fg1.body?.message, fg2.status])
      if (okay(fg1)) cleanups.push(() => call('POST', `/finished-goods/${fg1.body.data.id}/cancel`, { reason: 'ZZTEST phase 0 clean-up' }))
    } else {
      check('FG receipt: a ZZTEST finished item with a standard rate', false, { fgStore: !!fgStore, fgItem: !!fgItem })
    }

    // ── 7. A manual voucher sent twice saves once ──
    const company = await prisma.company.findFirst({ select: { booksStartDate: true, booksLockedUpTo: true } })
    const expenses = await prisma.ledger.findMany({ where: { isActive: true, group: { nature: 'EXPENSE' } }, take: 2, select: { id: true } })
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
    if (company?.booksStartDate && expenses.length === 2) {
      const v1 = rid()
      const vBody = {
        requestId: v1,
        kind: 'JOURNAL',
        date: today,
        narration: 'ZZTEST phase 0: repeat',
        lines: [
          { ledgerId: expenses[0].id, side: 'DR', amount: 1 },
          { ledgerId: expenses[1].id, side: 'CR', amount: 1 },
        ],
      }
      const vo1 = await call('POST', '/accounts/vouchers', vBody)
      const vo2 = await call('POST', '/accounts/vouchers', vBody)
      check('voucher: the repeat gets the same voucher back', vo1.status === 201 && vo2.status === 200 && vo2.body?.repeat === true && vo2.body?.data?.id === vo1.body?.data?.id, [vo1.status, vo1.body?.message, vo2.status])
      if (okay(vo1)) cleanups.push(() => call('POST', `/accounts/vouchers/${vo1.body.data.id}/cancel`, { reason: 'ZZTEST phase 0 clean-up' }))
    } else {
      check('voucher: books started and two expense ledgers', false, { started: !!company?.booksStartDate, ledgers: expenses.length })
    }

    // ── 8. Two requisitions reserving the same free stock at once ──
    const free = Math.floor(await bookQty(itemId, a))
    const dept = await prisma.department.findFirst({ where: { isActive: true }, select: { id: true } })
    if (free >= 2 && dept) {
      const mrs: string[] = []
      for (let i = 0; i < 2; i++) {
        const made = await call('POST', '/inventory/requisitions', {
          departmentId: dept.id,
          notes: 'ZZTEST phase 0: reserve race',
          lines: [{ itemId, requestedQty: free, warehouseId: a, purpose: 'ZZTEST phase 0' }],
        })
        if (!okay(made)) {
          check('reserve race: requisition made', false, made.body?.message)
          continue
        }
        mrs.push(made.body.data.id)
        cleanups.push(() => call('POST', `/inventory/requisitions/${made.body.data.id}/close`, { reason: 'ZZTEST phase 0 clean-up' }))
        const ok = await call('PATCH', `/inventory/requisitions/${made.body.data.id}/approve`, {})
        if (!okay(ok)) check('reserve race: requisition approved', false, [ok.status, ok.body?.message])
      }
      if (mrs.length === 2) {
        const lines = await prisma.materialRequisitionLine.findMany({ where: { mrId: { in: mrs } }, select: { id: true, mrId: true } })
        const lineOf = (mr: string) => lines.find((l) => l.mrId === mr)!.id
        const [r1, r2] = await Promise.all(
          mrs.map((mr) => call('POST', `/inventory/requisitions/${mr}/reserve`, { lines: [{ lineId: lineOf(mr), warehouseId: a, qty: free }] })),
        )
        const held = await prisma.stockReservation.aggregate({ where: { mrId: { in: mrs }, status: 'ACTIVE' }, _sum: { qty: true } })
        const heldQty = Number(held._sum.qty ?? 0)
        check('reserve race: exactly one of the two got the stock', [r1, r2].filter(okay).length === 1, [r1.status, r1.body?.message, r2.status, r2.body?.message])
        check('reserve race: never more held than the store has', heldQty <= free, { heldQty, free })
      }
    } else {
      check('reserve race: free stock and a department', false, { free, dept: !!dept })
    }

    // ── 9. The database refuses an unbalanced voucher ──
    const ledgers = await prisma.ledger.findMany({ where: { isActive: true }, take: 2, select: { id: true } })
    const no = `ZZTEST-UNBAL-${Date.now()}`
    let refused = ''
    let resolved = false
    try {
      await prisma.$transaction(async (tx) => {
        await tx.voucher.create({
          data: {
            kind: 'JOURNAL',
            voucherNo: no,
            financialYear: '2026-27',
            date: new Date(),
            amount: 1,
            lines: { create: [{ ledgerId: ledgers[0].id, debit: 1 }, { ledgerId: ledgers[1].id, credit: 2 }] },
          },
        })
        // What every writer of voucher lines does once its voucher is complete.
        await tx.$executeRawUnsafe('SET CONSTRAINTS "acc_voucher_lines_balance" IMMEDIATE')
        await tx.$executeRawUnsafe('SET CONSTRAINTS "acc_voucher_lines_balance" DEFERRED')
      })
      resolved = true
    } catch (e) {
      refused = (e as Error).message
    }
    check('database: an unbalanced voucher is refused, out loud', !resolved && /VOUCHER_NOT_BALANCED/.test(refused), { resolved, refused: refused.slice(0, 200) })
    check('database: nothing of it was kept', (await prisma.voucher.count({ where: { voucherNo: no } })) === 0)

    // Two balanced vouchers in one transaction, line by line, as an invoice
    // with its brokerage journal is written: the check waits between them.
    const two = [`ZZTEST-TWO-A-${Date.now()}`, `ZZTEST-TWO-B-${Date.now()}`]
    let twoError = ''
    try {
      await prisma.$transaction(async (tx) => {
        for (const voucherNo of two) {
          const v = await tx.voucher.create({ data: { kind: 'JOURNAL', voucherNo, financialYear: '2026-27', date: new Date(), amount: 1 }, select: { id: true } })
          await tx.voucherLine.create({ data: { voucherId: v.id, ledgerId: ledgers[0].id, debit: 1 } })
          await tx.voucherLine.create({ data: { voucherId: v.id, ledgerId: ledgers[1].id, credit: 1 } })
          await tx.$executeRawUnsafe('SET CONSTRAINTS "acc_voucher_lines_balance" IMMEDIATE')
          await tx.$executeRawUnsafe('SET CONSTRAINTS "acc_voucher_lines_balance" DEFERRED')
        }
        // Rolled back on purpose: a test leaves no vouchers behind.
        throw new Error('ROLLBACK_ON_PURPOSE')
      })
    } catch (e) {
      twoError = (e as Error).message
    }
    check('database: two balanced vouchers in one transaction, line by line, pass the check', twoError === 'ROLLBACK_ON_PURPOSE', twoError.slice(0, 200))
  } finally {
    // Undo in reverse order, so a later movement is taken back before the one it stood on.
    for (const undo of cleanups.reverse()) {
      const r = (await undo()) as Res | undefined
      if (r && !okay(r)) console.log(`clean-up: ${r.status} ${r.body?.message ?? ''}`)
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
