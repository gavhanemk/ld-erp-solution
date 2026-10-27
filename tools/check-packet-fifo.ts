// Packet stickers and FIFO, through the real routes, on the DEMO database only.
//
// One sticker for the life of a packet (50, then 40, then 35 on the same code),
// FIFO on what goes out (a newer packet waits for an older one unless the
// store manager allows it, with a reason), part of a packet moved to another
// store, the labels window after a typed issue, stock leaving without a scan,
// "issued by scan only", the Packet Balances and FIFO Exceptions reports, and
// packing set from the item import. Makes its own category, item, stock,
// packets and requisition, and deletes them all at the end.
//
// From apps/api, with the demo database in DATABASE_URL and DIRECT_URL:
//   npx tsx ../../tools/check-packet-fifo.ts
import { createRequire } from 'node:module'
import { join } from 'node:path'

// express and express-async-errors are apps/api's own. The patch has to be in
// before any route is made, so the app itself is loaded after it, in main().
const apiRequire = createRequire(join(process.cwd(), 'package.json'))
apiRequire('express-async-errors')
const express = apiRequire('express') as typeof import('express')
let disconnect = async () => {}

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
}

async function main() {
  const { prisma } = await import('../packages/database/src/index')
  disconnect = () => prisma.$disconnect()
  const { default: packagesRoutes } = await import('../apps/api/src/routes/packages.routes')
  const { default: inventoryRoutes } = await import('../apps/api/src/routes/inventory.routes')
  const { default: reportsRoutes } = await import('../apps/api/src/routes/reports.routes')
  const { errorHandler } = await import('../apps/api/src/middleware/errorHandler')
  const { recordMovement } = await import('../apps/api/src/services/stock.service')
  const { createPackages, olderPackage } = await import('../apps/api/src/services/package.service')
  const { learnPackSize } = await import('../apps/api/src/services/stickers.service')
  const { planImport, runImport } = await import('../apps/api/src/services/itemImport.service')
  const { invalidatePreferences } = await import('../apps/api/src/lib/preferences')

  const [where] = await prisma.$queryRaw<Array<{ db: string; port: number }>>`select current_database() as db, inet_server_port() as port`
  if (where.db !== 'lderp_demo' || Number(where.port) !== 5433) throw new Error(`Not the demo database (${where.db}:${where.port}) — stopping.`)

  const admin = await prisma.user.findFirstOrThrow({ where: { role: { name: 'Admin' } }, include: { role: true } })
  const other = await prisma.user.findFirstOrThrow({ where: { id: { not: admin.id } } })
  const asAdmin = { id: admin.id, email: admin.email, name: admin.name, roleId: admin.roleId, role: admin.role.name }
  // A storekeeper: can issue and move, cannot approve.
  const asClerk = { id: other.id, email: other.email, name: other.name, roleId: other.roleId, role: 'ZZ Storekeeper', permissions: ['inventory:view', 'inventory:create', 'inventory:edit'] }

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = req.headers['x-as'] === 'clerk' ? asClerk : asAdmin
    next()
  })
  app.use('/api/packages', packagesRoutes)
  app.use('/api/inventory', inventoryRoutes)
  app.use('/api/reports', reportsRoutes)
  app.use(errorHandler)
  const server = app.listen(0)
  const port = (server.address() as { port: number }).port
  const call = async (method: string, path: string, body?: unknown, as: 'admin' | 'clerk' = 'admin') => {
    const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-as': as },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, body: (await r.json()) as any }
  }

  const tag = `ZZCHK${Date.now().toString().slice(-6)}`
  const made = { categoryId: '', itemId: '', mrId: '', requestIds: [] as string[], settingCreated: false, customerItemDone: false }
  try {
    const uom = await prisma.uOM.findFirstOrThrow({ where: { isActive: true, OR: [{ symbol: 'pcs' }, { name: { contains: 'Piece' } }] } })
    const [storeA, storeB] = await prisma.warehouse.findMany({ where: { isActive: true }, take: 2, orderBy: { name: 'asc' } })
    const dept = await prisma.department.findFirstOrThrow({ where: { isActive: true } })
    const customer = await prisma.customer.findFirstOrThrow({ where: { isActive: true, NOT: { name: { contains: 'VHAGAR', mode: 'insensitive' } } } })
    const cat = await prisma.itemCategory.create({ data: { name: `${tag} Buttons`, trackPackages: true, packType: 'PACKET' } })
    made.categoryId = cat.id
    const item = await prisma.item.create({ data: { code: `${tag}-BTN`, name: `${tag} Shirt Button`, type: 'RAW_MATERIAL', categoryId: cat.id, uomId: uom.id, standardRate: 2 } })
    made.itemId = item.id
    console.log(`test item ${item.code} in ${storeA.name}; other store ${storeB.name}`)
    const spotA = { itemId: item.id, warehouseId: storeA.id, ownership: 'OWNED' as const, ownerCustomerId: null }

    /** Stock in and one sticker for it, as a GRN would make. */
    const inward = async (qty: number, grn: string, daysAgo = 0) =>
      prisma.$transaction(async (tx) => {
        await recordMovement(tx, { itemId: item.id, warehouseId: storeA.id, transactionType: 'OPENING', direction: 'IN', qty, unitRate: 2, referenceType: 'ZZCHECK', referenceId: `${tag}-${grn}` })
        const [p] = await createPackages(tx, { spot: spotA, packType: 'PACKET', qtys: [qty], sourceType: 'GRN', sourceId: `${tag}-${grn}`, sourceRef: grn, userId: admin.id, unit: 'pcs', itemName: item.name })
        if (daysAgo) await tx.stockPackage.update({ where: { id: p.id }, data: { createdAt: new Date(Date.now() - daysAgo * 86400000) } })
        return p
      })

    // ── Packet size remembered ──────────────────────────────────────────
    await learnPackSize(prisma, item.id, Array(10).fill(50), 'PACKET')
    let it = await prisma.item.findUniqueOrThrow({ where: { id: item.id } })
    check('1. a receipt of 10 packets of 50 teaches the item 50 a packet', Number(it.packQty) === 50 && it.packType === 'PACKET', `${it.packQty} ${it.packType}`)
    await learnPackSize(prisma, item.id, [20, 20, 20], 'BOX')
    it = await prisma.item.findUniqueOrThrow({ where: { id: item.id } })
    check('   a qty per sticker already set is never changed', Number(it.packQty) === 50 && it.packType === 'PACKET')

    // ── One sticker, 50 → 40 → 35 ───────────────────────────────────────
    const p1 = await inward(50, 'GRN-A', 5)
    check('2. 50 in on a receipt: one sticker, balance 50', Number(p1.qty) === 50 && p1.status === 'IN_STOCK', p1.code)
    const mr = await prisma.materialRequisition.create({
      data: { mrNumber: `${tag}-MR`, departmentId: dept.id, status: 'APPROVED', lines: { create: [{ itemId: item.id, requestedQty: 400, warehouseId: storeA.id }] } },
      include: { lines: true },
    })
    made.mrId = mr.id
    const lineId = mr.lines[0].id
    const scanIssue = (pkgId: string, qty: number, extra: Record<string, unknown> = {}, as: 'admin' | 'clerk' = 'admin') =>
      call('POST', `/packages/${pkgId}/issue`, { mrId: mr.id, lineId, qty, ...extra }, as)

    let r = await scanIssue(p1.id, 10)
    let row = await prisma.stockPackage.findUniqueOrThrow({ where: { id: p1.id } })
    const mv = await prisma.stockPackageMove.findFirst({ where: { packageId: p1.id, type: 'ISSUED' }, orderBy: { createdAt: 'desc' } })
    check('3. issue 10 by scan: same code, balance 40', r.status === 200 && row.status === 'IN_STOCK' && Number(row.qty) === 40 && r.body.data.code === p1.code && !r.body.data.newSticker, `${r.status} ${r.body.message}`)
    check('   its history says 10 went to the requisition, 40 after', Number(mv?.qty) === -10 && Number(mv?.balanceAfter) === 40 && mv?.referenceNumber === mr.mrNumber)
    r = await scanIssue(p1.id, 5)
    row = await prisma.stockPackage.findUniqueOrThrow({ where: { id: p1.id } })
    check('4. issue 5 more: same code, balance 35', r.status === 200 && Number(row.qty) === 35 && row.code === p1.code, r.body.message)
    r = await scanIssue(p1.id, 40)
    check('5. issuing 40 from it is refused: only 35 in it', r.status === 400 && r.body.code === 'OVER_PACKAGE', r.body.message)
    const rid = `${tag}-req-1`
    made.requestIds.push(rid)
    const a1 = await scanIssue(p1.id, 5, { requestId: rid })
    const a2 = await scanIssue(p1.id, 5, { requestId: rid })
    row = await prisma.stockPackage.findUniqueOrThrow({ where: { id: p1.id } })
    check('6. the same scan sent twice issues once', a1.status === 200 && a2.status === 200 && a2.body.repeat === true && Number(row.qty) === 30, `qty ${row.qty}`)
    r = await scanIssue(p1.id, 30)
    row = await prisma.stockPackage.findUniqueOrThrow({ where: { id: p1.id } })
    const again = await scanIssue(p1.id, 1)
    check('7. the last 30 empties it; scanned again it says where it went', r.status === 200 && row.status === 'EMPTY' && again.status === 409 && again.body.code === 'ALREADY_ISSUED' && String(again.body.message).includes(mr.mrNumber), again.body.message)
    const split = await prisma.stockPackage.count({ where: { itemId: item.id, sourceType: 'SPLIT' } })
    check('   no new stickers were made by any of those issues', split === 0, `${split} split packages`)

    // ── FIFO ────────────────────────────────────────────────────────────
    const older = await inward(50, 'GRN-B', 2)
    const newer = await inward(50, 'GRN-C', 0)
    r = await scanIssue(newer.id, 10)
    check('8. scanning the newer packet is blocked and names the older one', r.status === 409 && r.body.code === 'FIFO_OLDER' && String(r.body.message).includes(older.code), r.body.message)
    r = await scanIssue(newer.id, 10, {}, 'clerk')
    const rc = await scanIssue(newer.id, 10, { fifoReason: 'Older package damaged' }, 'clerk')
    check('9. a storekeeper cannot let it go first, even with a reason', r.status === 409 && rc.status === 403 && rc.body.code === 'FIFO_NEEDS_MANAGER', rc.body.message)
    r = await scanIssue(newer.id, 10, { fifoReason: 'Matching lot or shade' })
    const fm = await prisma.stockPackageMove.findFirst({ where: { packageId: newer.id, type: 'ISSUED' }, orderBy: { createdAt: 'desc' } })
    check('10. the store manager lets it go first with a reason; the reason is kept', r.status === 200 && fm?.fifoReason === 'Matching lot or shade' && fm?.fifoSkippedId === older.id, r.body.message)
    await prisma.stockPackage.update({ where: { id: older.id }, data: { grade: 'R' } })
    r = await scanIssue(newer.id, 5)
    await prisma.stockPackage.update({ where: { id: older.id }, data: { grade: 'A' } })
    check('11. an older packet on hold does not block a good newer one', r.status === 200, r.body.message)
    // A customer's older packet of the same item does not count against ours.
    const custPkg = await prisma.$transaction(async (tx) => {
      await recordMovement(tx, { itemId: item.id, warehouseId: storeA.id, transactionType: 'CUSTOMER_MATERIAL', direction: 'IN', qty: 20, unitRate: 0, ownership: 'CUSTOMER_OWNED', ownerCustomerId: customer.id, referenceType: 'ZZCHECK', referenceId: `${tag}-CUST` })
      const [p] = await createPackages(tx, { spot: { ...spotA, ownership: 'CUSTOMER_OWNED', ownerCustomerId: customer.id }, packType: 'PACKET', qtys: [20], sourceType: 'CUSTOMER_GRN', sourceId: `${tag}-CUST`, userId: admin.id, unit: 'pcs', itemName: item.name })
      await tx.stockPackage.update({ where: { id: p.id }, data: { createdAt: new Date(Date.now() - 10 * 86400000) } })
      return p
    })
    made.customerItemDone = true
    const olderOfOlder = await olderPackage(prisma, await prisma.stockPackage.findUniqueOrThrow({ where: { id: older.id } }))
    const newerRow = await prisma.stockPackage.findUniqueOrThrow({ where: { id: newer.id } })
    const olderOfNewer = await olderPackage(prisma, newerRow)
    check('12. a customer’s older packet is a different owner: ours are compared only with ours', olderOfOlder === null && olderOfNewer?.id === older.id && olderOfNewer?.id !== custPkg.id)

    // ── Moving part of a packet ─────────────────────────────────────────
    r = await call('POST', `/packages/${older.id}/transfer`, { toWarehouseId: storeB.id, qty: 10 })
    const olderAfter = await prisma.stockPackage.findUniqueOrThrow({ where: { id: older.id } })
    const moved = r.body.data?.newPackage ? await prisma.stockPackage.findUnique({ where: { id: r.body.data.newPackage.id } }) : null
    check('13. moving 10 to another store: the 10 get their own sticker; this one keeps its code with 40', r.status === 200 && olderAfter.status === 'IN_STOCK' && Number(olderAfter.qty) === 40 && olderAfter.warehouseId === storeA.id && moved?.warehouseId === storeB.id && Number(moved?.qty) === 10 && moved?.parentId === older.id, r.body.message)
    r = await call('POST', `/packages/${newer.id}/transfer`, { toWarehouseId: storeB.id, qty: 5 })
    check('   moving from the newer one while the older has stock is blocked too', r.status === 409 && r.body.code === 'FIFO_OLDER', r.body.message)

    // ── Typed issue, then the labels window ─────────────────────────────
    const typed = async (qty: number, as: 'admin' | 'clerk' = 'admin') => call('POST', `/inventory/requisitions/${mr.id}/issue`, { lines: [{ lineId, issueQty: qty, warehouseId: storeA.id }] }, as)
    r = await typed(5)
    const plan = await call('POST', '/packages/outward/plan', { type: 'MR', id: mr.id, q: `${lineId}:5:${storeA.id}` })
    const spot = plan.body.data?.spots?.[0]
    const proposed = (spot?.packages ?? []).filter((p: any) => p.take > 0)
    check('14. a typed issue proposes the oldest packet in the window', r.status === 200 && proposed.length === 1 && proposed[0].id === older.id && proposed[0].take === 5, JSON.stringify(proposed.map((p: any) => [p.code, p.take])))
    r = await call('POST', '/packages/outward/apply', { type: 'MR', id: mr.id, q: `${lineId}:5:${storeA.id}`, takes: [{ packageId: older.id, qty: 5 }] })
    const olderTyped = await prisma.stockPackage.findUniqueOrThrow({ where: { id: older.id } })
    check('   taking it off the oldest keeps the same code: 40 → 35', r.status === 200 && Number(olderTyped.qty) === 35 && olderTyped.status === 'IN_STOCK' && (r.body.data.reprint ?? []).length === 0, r.body.message)
    r = await typed(5)
    const wrong = await call('POST', '/packages/outward/apply', { type: 'MR', id: mr.id, q: `${lineId}:5:${storeA.id}`, takes: [{ packageId: newer.id, qty: 5 }] })
    const wrongClerk = await call('POST', '/packages/outward/apply', { type: 'MR', id: mr.id, q: `${lineId}:5:${storeA.id}`, takes: [{ packageId: newer.id, qty: 5 }], fifoReason: 'Older package cannot be reached' }, 'clerk')
    const right = await call('POST', '/packages/outward/apply', { type: 'MR', id: mr.id, q: `${lineId}:5:${storeA.id}`, takes: [{ packageId: newer.id, qty: 5 }], fifoReason: 'Older package cannot be reached' })
    check('15. picking the newer one in the window needs the store manager and a reason', wrong.status === 409 && wrongClerk.status === 403 && right.status === 200, `${wrong.status}/${wrongClerk.status}/${right.status}`)

    // ── Stock leaving without a scan keeps the sticker ──────────────────
    const before = await prisma.stockPackage.findUniqueOrThrow({ where: { id: older.id } })
    await prisma.$transaction((tx) => recordMovement(tx, { itemId: item.id, warehouseId: storeA.id, transactionType: 'ADJUSTMENT', direction: 'OUT', qty: 7, referenceType: 'ZZCHECK', referenceId: `${tag}-OUT` }))
    const after = await prisma.stockPackage.findUniqueOrThrow({ where: { id: older.id } })
    check('16. stock going out without a scan comes off the oldest packet, same code', after.status === 'IN_STOCK' && Number(after.qty) === Number(before.qty) - 7 && after.code === older.code, `${before.qty} → ${after.qty}`)

    // ── Issued by scan only ─────────────────────────────────────────────
    const company = await prisma.company.findFirstOrThrow()
    const had = await prisma.appSetting.findUnique({ where: { companyId_key: { companyId: company.id, key: 'issueByScanOnly' } } })
    if (had) throw new Error('issueByScanOnly is already set on the demo; not touching it.')
    await prisma.appSetting.create({ data: { companyId: company.id, key: 'issueByScanOnly', value: true } })
    made.settingCreated = true
    invalidatePreferences()
    r = await typed(5)
    check('17. with scan-only on, typing an issue of stickered stock is refused', r.status === 400 && r.body.code === 'SCAN_TO_ISSUE', r.body.message)
    await prisma.$transaction((tx) => recordMovement(tx, { itemId: item.id, warehouseId: storeA.id, transactionType: 'OPENING', direction: 'IN', qty: 3, unitRate: 2, referenceType: 'ZZCHECK', referenceId: `${tag}-LOOSE` }))
    const tooMuch = await typed(4)
    const loose = await typed(3)
    check('   only the 3 without a sticker can be typed', tooMuch.status === 400 && loose.status === 200, `${tooMuch.status} / ${loose.status}`)
    const byScan = await scanIssue(older.id, 2)
    check('   a scan still issues as before', byScan.status === 200, byScan.body.message)
    await prisma.appSetting.deleteMany({ where: { companyId: company.id, key: 'issueByScanOnly' } })
    made.settingCreated = false
    invalidatePreferences()
    r = await typed(1)
    check('   switched off again, a typed issue works as it always did', r.status === 200, r.body.message)

    // ── Reports ─────────────────────────────────────────────────────────
    const bal = await call('GET', `/reports/packet-balances/run?warehouseId=${storeA.id}&categoryId=${cat.id}`)
    const rows = (bal.body.data?.rows ?? bal.body.rows ?? []) as any[]
    const mine = rows.filter((x) => x.itemCode === item.code)
    check('18. packet balances lists ours, oldest first, with what is left', bal.status === 200 && mine.length >= 2 && mine[0].sticker === older.code && mine[0].state === 'OPEN', JSON.stringify(mine.map((x) => [x.sticker, x.packed, x.issued, x.balance, x.state])))
    const fx = await call('GET', `/reports/fifo-exceptions/run?categoryId=${cat.id}`)
    const frows = (fx.body.data?.rows ?? fx.body.rows ?? []) as any[]
    check('   FIFO exceptions lists both times, with the reason and the older packet', fx.status === 200 && frows.length === 2 && frows.every((x) => x.skipped === older.code) && frows.some((x) => x.reason === 'Matching lot or shade'), JSON.stringify(frows.map((x) => [x.sticker, x.skipped, x.reason, x.by])))

    // ── Import sets packing on an item already there ────────────────────
    const plans = await planImport([
      { row: 2, raw: { code: item.code, name: item.name, packType: 'Box', packQty: '25' } },
    ])
    check('19. import: a row giving packing for an item already there sets just that', plans[0].plan.pack === 'Box of 25' && !plans[0].plan.skipped && plans[0].plan.problems.length === 0, JSON.stringify(plans[0].plan))
    const done = await runImport(plans)
    it = await prisma.item.findUniqueOrThrow({ where: { id: item.id } })
    check('   saved: Box of 25, nothing else changed', done.packsSet === 1 && done.created.length === 0 && it.packType === 'BOX' && Number(it.packQty) === 25 && it.name === item.name && it.categoryId === cat.id)
    const same = await planImport([{ row: 2, raw: { code: item.code, name: item.name, packType: 'Box', packQty: '25' } }])
    check('   the same packing again is skipped, as an unchanged row always was', same[0].plan.skipped === true && !same[0].packUpdate)
  } finally {
    // Everything this made, and nothing else.
    if (made.settingCreated) {
      await prisma.appSetting.deleteMany({ where: { key: 'issueByScanOnly' } })
      invalidatePreferences()
    }
    if (made.itemId) {
      const transfers = await prisma.stockTransferLine.findMany({ where: { itemId: made.itemId }, select: { transferId: true } })
      await prisma.stockPackage.deleteMany({ where: { itemId: made.itemId, parentId: { not: null } } })
      await prisma.stockPackage.deleteMany({ where: { itemId: made.itemId } })
      await prisma.stockLedger.deleteMany({ where: { itemId: made.itemId } })
      await prisma.stockTransferLine.deleteMany({ where: { itemId: made.itemId } })
      for (const t of new Set(transfers.map((x) => x.transferId))) {
        const left = await prisma.stockTransferLine.count({ where: { transferId: t } })
        if (!left) await prisma.stockTransfer.delete({ where: { id: t } })
      }
      if (made.mrId) {
        await prisma.materialRequisitionLine.deleteMany({ where: { mrId: made.mrId } })
        await prisma.materialRequisition.delete({ where: { id: made.mrId } })
      }
      await prisma.item.delete({ where: { id: made.itemId } })
    }
    if (made.categoryId) await prisma.itemCategory.delete({ where: { id: made.categoryId } })
    if (made.requestIds.length) await prisma.stockRequest.deleteMany({ where: { id: { in: made.requestIds } } })
    server.close()
  }
  console.log(`\n${pass} passed, ${fail} failed — everything the check made has been deleted`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => disconnect())
