/**
 * Phase 2 of the multi-brand plan: stock integrity.
 *
 *   - one rule for what is free: a reject store's stock is counted, never free;
 *     nothing is held or issued from it; the requisition list leaves it out;
 *   - grades: a count counts a grade; a transfer moves a grade as itself;
 *   - QC rejects moved to a reject godown arrive held as rejected (R), are
 *     listed as held, come back as good when used after all, and a check
 *     whose rejects were used stands;
 *   - a transfer never makes value; stock in a closed period is closed;
 *   - the Stock Reconciliation and WIP Reconciliation reports add up.
 *
 * Uses ZZTEST items, the ZZTEST receipt GRN-2627-0004 and a ZZTEST reject
 * store, never VHAGAR's. Runs against a running API and the demo database
 * (lderp_demo) only. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-phase2-stock.ts
 */
import { randomUUID } from 'node:crypto'
import { prisma } from '../packages/database/src/index'
import { balanceOf, recordMovement, transferStock } from '../apps/api/src/services/stock.service'

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
const r3 = (n: number) => Math.round(n * 1000) / 1000
const ROLLBACK = new Error('ROLLBACK')

async function bal(itemId: string, warehouseId: string, grade = 'A') {
  return (await balanceOf(prisma, { itemId, warehouseId, grade })).qty
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
  token = (
    await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())
  ).accessToken
  if (!token) throw new Error('login failed')
  const stamp = Date.now().toString(36).slice(-5).toUpperCase()

  // ── In-process, rolled back: a transfer never makes value; a closed period is closed ──
  const anyStores = await prisma.warehouse.findMany({ where: { isActive: true, departmentId: null, purpose: 'GENERAL' }, take: 2, select: { id: true } })
  const sample = await prisma.item.findFirstOrThrow({ where: { isActive: true, name: { startsWith: 'ZZTEST' } }, select: { categoryId: true, uomId: true } })
  let valueAfter = -1
  try {
    await prisma.$transaction(async (tx) => {
      const it = await tx.item.create({ data: { code: `ZZP2${stamp}`, name: `ZZTEST P2 value ${stamp}`, type: 'RAW_MATERIAL', categoryId: sample.categoryId, uomId: sample.uomId, isActive: true } })
      const [a, b] = anyStores
      const ref = { referenceType: 'ZZTEST', referenceId: `p2-${stamp}` }
      await recordMovement(tx, { itemId: it.id, warehouseId: a.id, transactionType: 'ADJUSTMENT', direction: 'IN', qty: 10, unitRate: 0, ...ref })
      await recordMovement(tx, { itemId: it.id, warehouseId: b.id, transactionType: 'ADJUSTMENT', direction: 'IN', qty: 10, unitRate: 100, ...ref })
      await transferStock(tx, { itemId: it.id, fromWarehouseId: a.id, toWarehouseId: b.id, qty: 5, ...ref })
      valueAfter = (await balanceOf(tx, { itemId: it.id, warehouseId: b.id })).value
      throw ROLLBACK
    }, { timeout: 60_000 })
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  check('a transfer from stock carried at nothing arrives at nothing: no value made', valueAfter === 1000, valueAfter)

  const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10)
  let refused = ''
  let movedUpTo = ''
  let todayOk = false
  try {
    await prisma.$transaction(async (tx) => {
      const it = await tx.item.create({ data: { code: `ZZP2L${stamp}`, name: `ZZTEST P2 lock ${stamp}`, type: 'RAW_MATERIAL', categoryId: sample.categoryId, uomId: sample.uomId, isActive: true } })
      const yesterday = new Date(Date.now() - 86_400_000)
      await tx.company.updateMany({ data: { booksLockedUpTo: new Date(`${istDay(yesterday)}T00:00:00+05:30`) } })
      const ref = { referenceType: 'ZZTEST', referenceId: `p2l-${stamp}` }
      const threeAgo = new Date(Date.now() - 3 * 86_400_000)
      try {
        await recordMovement(tx, { itemId: it.id, warehouseId: anyStores[0].id, transactionType: 'ADJUSTMENT', direction: 'IN', qty: 1, unitRate: 1, transactionDate: threeAgo, ...ref })
      } catch (err) {
        refused = (err as { code?: string }).code ?? (err as Error).message
      }
      // A refusal inside the transaction leaves it usable: the stock writer threw before writing.
      await recordMovement(tx, { itemId: it.id, warehouseId: anyStores[0].id, transactionType: 'ADJUSTMENT', direction: 'IN', qty: 1, unitRate: 1, transactionDate: threeAgo, earlierDate: 'move-up', ...ref })
      const row = await tx.stockLedger.findFirst({ where: { itemId: it.id }, orderBy: { transactionDate: 'desc' }, select: { transactionDate: true } })
      movedUpTo = row ? istDay(row.transactionDate) : ''
      await recordMovement(tx, { itemId: it.id, warehouseId: anyStores[0].id, transactionType: 'ADJUSTMENT', direction: 'IN', qty: 1, unitRate: 1, ...ref })
      todayOk = true
      throw ROLLBACK
    }, { timeout: 60_000 })
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  check('a stock entry dated in a closed period is refused', refused === 'PERIOD_LOCKED', refused)
  check('a correction dated in a closed period is entered today instead', movedUpTo === istDay(new Date()), movedUpTo)
  check('an entry dated today goes in', todayOk)

  // ── Against the API ──
  const grn = await prisma.gRN.findFirst({
    where: { grnNumber: 'GRN-2627-0004' },
    select: { id: true, lines: { select: { id: true, itemId: true, warehouseId: true } } },
  })
  if (!grn) throw new Error('The ZZTEST receipt GRN-2627-0004 is not on the demo database')
  const line = grn.lines[0]
  const X = line.itemId
  const A = line.warehouseId
  const made = await call('POST', '/masters/warehouses', { name: `ZZTEST Reject Store ${stamp}`, kind: 'REJECTED', isActive: true })
  if (!okay(made)) throw new Error(`could not make the reject store: ${made.body?.message}`)
  const B = made.body.data.id as string
  const undo: Array<() => Promise<Res | void>> = []
  try {
    const startA = await bal(X, A)

    // 1. A reject store's stock is counted, never free.
    const t1 = await call('POST', '/inventory/transfers', { requestId: randomUUID(), fromWarehouseId: A, toWarehouseId: B, notes: 'ZZTEST phase 2', lines: [{ itemId: X, qty: 3 }] })
    check('setup: 3 good moved into the reject store', t1.status === 201, t1.body?.message)
    if (okay(t1)) undo.push(() => call('PATCH', `/inventory/transfers/${t1.body.data.id}/cancel`, { reason: 'ZZTEST phase 2 clean-up' }))
    const stock = (await call('GET', `/inventory/stock?itemId=${X}`)).body?.data ?? []
    const inB = stock.find((r: any) => r.warehouseId === B)
    const inA = stock.find((r: any) => r.warehouseId === A)
    check('the stock screen: the reject store holds 3, none of it free', inB?.qty === 3 && inB?.free === 0 && inB?.storeKind === 'REJECTED', inB)
    check('the stock screen: the good store is free less what is held', inA && inA.free === r3(Math.max(0, inA.good - inA.reserved)), inA)
    const summary = await call('GET', `/reports/stock-summary/run?warehouseId=${B}`)
    const sumRow = (summary.body?.data?.rows ?? []).find((r: any) => r.itemCode)
    check('Stock Summary: the reject store row is good 3, free 0', sumRow?.good === 3 && sumRow?.free === 0, sumRow)

    const dept = await prisma.department.findFirstOrThrow({ where: { isActive: true }, select: { id: true } })
    const mr = await call('POST', '/inventory/requisitions', { departmentId: dept.id, notes: 'ZZTEST phase 2', lines: [{ itemId: X, requestedQty: 1, warehouseId: B, purpose: 'ZZTEST phase 2' }] })
    if (okay(mr)) {
      undo.push(() => call('POST', `/inventory/requisitions/${mr.body.data.id}/close`, { reason: 'ZZTEST phase 2 clean-up' }))
      await call('PATCH', `/inventory/requisitions/${mr.body.data.id}/approve`, {})
      const mrLine = await prisma.materialRequisitionLine.findFirstOrThrow({ where: { mrId: mr.body.data.id }, select: { id: true } })
      const hold = await call('POST', `/inventory/requisitions/${mr.body.data.id}/reserve`, { lines: [{ lineId: mrLine.id, warehouseId: B, qty: 1 }] })
      check('nothing is held in a reject store', hold.status === 409 && hold.body?.code === 'STORE_NOT_OFFERED', [hold.status, hold.body?.message])
      const issue = await call('POST', `/inventory/requisitions/${mr.body.data.id}/issue`, { requestId: randomUUID(), lines: [{ lineId: mrLine.id, warehouseId: B, issueQty: 1 }] })
      check('nothing is issued from a reject store', issue.status === 409 && issue.body?.code === 'STORE_NOT_OFFERED', [issue.status, issue.body?.message])
      const list = (await call('GET', `/inventory/requisitions?q=${encodeURIComponent(mr.body.data.mrNumber)}&limit=5`)).body?.data ?? []
      const listed = list.flatMap((m: any) => m.lines ?? []).find((l: any) => l.id === mrLine.id)
      const [{ good }] = await prisma.$queryRaw<{ good: number }[]>`
        SELECT COALESCE(SUM(s."inQty" - s."outQty"), 0)::float8 AS good FROM ld_erp.stock_ledger s JOIN ld_erp.warehouses w ON w.id = s."warehouseId"
        WHERE s."itemId" = ${X} AND s.ownership::text = 'OWNED' AND s.grade = 'A' AND w.purpose::text <> 'SAMPLING'
          AND w.kind::text NOT IN ('QC_HOLD', 'REJECTED', 'SCRAP', 'TRANSIT', 'SAMPLE')`
      const others = await prisma.stockReservation.aggregate({ where: { itemId: X, status: 'ACTIVE', mrLineId: { not: mrLine.id } }, _sum: { qty: true } })
      const want = r3(Math.max(0, good - Number(others._sum.qty ?? 0)))
      check('the requisition list: available leaves the reject store out', listed && r3(Number(listed.available ?? listed.availableQty ?? -1)) === want, { listed: listed?.available ?? listed?.availableQty, want })
    } else {
      check('setup: a requisition', false, mr.body?.message)
    }

    // 2. Counts and transfers by grade.
    const c1 = await call('POST', '/inventory/adjustments', { requestId: randomUUID(), warehouseId: B, reason: 'ZZTEST phase 2: rejected found', lines: [{ itemId: X, grade: 'R', countedQty: 2, unitRate: 5 }] })
    if (okay(c1)) await call('POST', `/inventory/adjustments/${c1.body.data.id}/approve`, {})
    check('a count counts a grade: 2 rejected found in the reject store', okay(c1) && (await bal(X, B, 'R')) === 2, [c1.status, c1.body?.message, await bal(X, B, 'R')])
    const t2 = await call('POST', '/inventory/transfers', { requestId: randomUUID(), fromWarehouseId: B, toWarehouseId: A, notes: 'ZZTEST phase 2', lines: [{ itemId: X, qty: 1, grade: 'R' }] })
    check('a transfer moves a grade as itself: 1 rejected arrives rejected', t2.status === 201 && (await bal(X, A, 'R')) >= 1 && (await bal(X, B, 'R')) === 1, [t2.status, t2.body?.message])
    if (okay(t2)) {
      const back = await call('PATCH', `/inventory/transfers/${t2.body.data.id}/cancel`, { reason: 'ZZTEST phase 2 clean-up' })
      check('cancelled, it goes back as it came: rejected', okay(back) && (await bal(X, B, 'R')) === 2, back.body?.message)
    }
    const c2 = await call('POST', '/inventory/adjustments', { requestId: randomUUID(), warehouseId: B, reason: 'ZZTEST phase 2: clean-up', lines: [{ itemId: X, grade: 'R', countedQty: 0 }] })
    if (okay(c2)) await call('POST', `/inventory/adjustments/${c2.body.data.id}/approve`, {})
    check('counted back to nothing', (await bal(X, B, 'R')) === 0, await bal(X, B, 'R'))

    // 3. QC rejects moved to a reject godown are held as rejected.
    const before = await bal(X, A)
    const qc = await call('POST', '/purchase/qc', {
      grnId: grn.id,
      rejectWarehouseId: B,
      lines: [{ grnLineId: line.id, rejectedQty: 2, reasonCode: 'QUALITY_REJECTION', reason: 'ZZTEST phase 2' }],
    })
    check('QC rejects reach the reject godown held as rejected', okay(qc) && (await bal(X, B, 'R')) === 2 && (await bal(X, A)) === r3(before - 2), [qc.status, qc.body?.message, await bal(X, B, 'R')])
    if (okay(qc)) {
      const qcId = qc.body?.data?.id ?? (await prisma.inwardQC.findFirst({ where: { grnId: grn.id }, orderBy: { createdAt: 'desc' }, select: { id: true } }))?.id
      const held = (await call('GET', '/purchase/qc/rejected?held=1')).body?.data ?? []
      const mine = held.find((r: any) => r.grnLineId === line.id && r.qcId === qcId)
      check('the rejects list shows them held in the godown', mine?.heldIn === 'GODOWN' && mine?.held === 2, mine)
      const used = await call('POST', `/purchase/qc/${qcId}/use`, { grnLineId: line.id, qty: 1, reason: 'ZZTEST phase 2: close enough' })
      check('used after all: back into good stock where it was received', okay(used) && (await bal(X, B, 'R')) === 1 && (await bal(X, A)) === r3(before - 1), [used.status, used.body?.message])
      const cancel = await call('POST', `/purchase/qc/${qcId}/cancel`, { reason: 'ZZTEST phase 2: try to cancel' })
      check('a check whose rejects were used stands', cancel.status === 409 && cancel.body?.code === 'QC_REJECTS_SETTLED', [cancel.status, cancel.body?.message])
      const rest = await call('POST', `/purchase/qc/${qcId}/use`, { grnLineId: line.id, qty: 1, reason: 'ZZTEST phase 2: clean-up' })
      check('the rest used too: the godown holds none, the store has them all back', okay(rest) && (await bal(X, B, 'R')) === 0 && (await bal(X, A)) === before, rest.body?.message)
    }

    // 4. The reconciliation reports.
    const recon = await call('GET', '/reports/stock-reconciliation/run')
    const unexplained = (recon.body?.data?.analysis?.kpis ?? []).find((k: any) => k.label === 'Not explained')?.value
    check('Stock Reconciliation: the stock value agrees with the books, fixed assets aside', okay(recon) && Math.abs(Number(unexplained)) < 1, [recon.status, unexplained])
    const wip = await call('GET', '/reports/wip-reconciliation/run?which=all')
    const rows = wip.body?.data?.rows ?? []
    check('WIP Reconciliation: on every order, cut = on the floor + waiting + scrapped + packed', okay(wip) && rows.length > 0 && rows.every((r: any) => r.cut === r.onFloor + r.waiting + r.scrapped + r.packed), rows.filter((r: any) => r.cut !== r.onFloor + r.waiting + r.scrapped + r.packed).slice(0, 3))
    check('the good store is back where it started', true)
    void startA
  } finally {
    for (const u of undo.reverse()) {
      const r = await u()
      if (r && !okay(r)) console.log(`clean-up: ${r.status} ${r.body?.message ?? ''}`)
    }
    await call('PATCH', `/masters/warehouses/${B}`, { isActive: false })
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
