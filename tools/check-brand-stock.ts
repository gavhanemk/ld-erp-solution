/**
 * Multi-brand phase 5: central stock earmarked for brands.
 *
 *   1. Decision 5 on the real stock engine: the valuation scenario run
 *      through recordMovement and an approved earmark gives exactly the
 *      figures tools/valuation-impact.ts works out for "each share its own
 *      average" — issued, each share's closing stock, the company's total.
 *   2. Decision 8: a reallocation is approved by someone other than its
 *      maker; an Admin approving their own needs an override reason, kept on
 *      it. Moves and releases go at the giving share's average; the
 *      company's stock and value never change; a share keeps its own average
 *      when central stock is bought at another price.
 *   3. Holds stay protected; a customer's material can never be a brand's;
 *      stock with no brand named takes central only, and says whose the rest is.
 *   4. A part of a roll earmarked rides on it as a child sticker (same lot);
 *      stickers agree with the ledger share by share; the reversal puts it back.
 *   5. Decision 7: an MO's issue takes its brand's own share first, then moves
 *      central stock by itself — only for an authorised MO (not a draft, not
 *      on hold), within what it still needs; never another brand's earmark.
 *      Floor returns go back to the brand's share; a return's cancellation
 *      takes it out of the same share. Stickers stay right either way: a
 *      typed issue's automatic move takes the oldest central rolls with it,
 *      and a scanned central roll comes down with the issue; another
 *      brand's scanned roll is refused.
 *   6. Transfers: a brand's share moves as itself, direct and in transit.
 *   7. Stock Reconciliation finds nothing, share by share.
 *
 * ZZTEST brands, stores and items, inside one transaction that always
 * throws: nothing is kept. Demo database (lderp_demo) only. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   npx tsx ../../tools/check-brand-stock.ts
 */
import { prisma } from '../packages/database/src/index'
import { balanceOf, recordMovement } from '../apps/api/src/services/stock.service'
import { approveReallocation, cancelReallocation, raiseReallocation, rejectReallocation, reverseReallocation, type RaiseInput } from '../apps/api/src/services/brandStock.service'
import { cancelFloorReturn, createTransfer, issueRequisition, returnFromFloor } from '../apps/api/src/routes/inventory.routes'
import { receiveTransfer } from '../apps/api/src/services/transitTransfer.service'
import { materialPlan } from '../apps/api/src/services/manufacturing.service'
import { createPackages, sharePositions, takeFromPackage } from '../apps/api/src/services/package.service'
import { stockReconciliation } from '../apps/api/src/reports/definitions/stock-reconciliation'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 700)}` : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const stamp = Date.now().toString(36).slice(-5).toUpperCase()
const r2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== 'lderp_demo') {
    console.error('Refusing to run: not lderp_demo.')
    process.exitCode = 2
    return
  }
  const admin = await prisma.user.findFirstOrThrow({ where: { role: { name: { in: ['Super Admin', 'Admin'] } } }, select: { id: true, name: true } })
  const other = await prisma.user.findFirstOrThrow({ where: { id: { not: admin.id } }, select: { id: true } })
  const company = await prisma.company.findFirstOrThrow({ select: { id: true } })
  const like = await prisma.item.findFirstOrThrow({ where: { isActive: true, type: 'RAW_MATERIAL', name: { startsWith: 'ZZTEST' } }, select: { categoryId: true, uomId: true } })
  const customer = await prisma.customer.findFirstOrThrow({ select: { id: true } })
  const asAdmin = { id: admin.id, email: '', name: admin.name, roleId: '', role: 'Super Admin', superAdmin: true }

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
        // ── ZZTEST brands, stores and fabrics ──
        const brand = async (tag: string) =>
          (await tx.brand.create({ data: { companyId: company.id, name: `ZZTEST BS ${tag} ${stamp}`, type: 'LD_COTTON_MILLS' }, select: { id: true } })).id
        const A = await brand('A')
        const B = await brand('B')
        const store = async (tag: string) => (await tx.warehouse.create({ data: { companyId: company.id, name: `ZZTEST BS ${tag} ${stamp}`, code: `ZZBS${tag}${stamp}`, kind: 'GENERAL' }, select: { id: true } })).id
        const S = await store('S')
        const T = await store('T')
        const fabric = async (tag: string) =>
          (await tx.item.create({ data: { code: `ZZBS${tag}${stamp}`, name: `ZZTEST BS fabric ${tag} ${stamp}`, type: 'RAW_MATERIAL', categoryId: like.categoryId, uomId: like.uomId }, select: { id: true } })).id
        let ref = 0
        const put = (itemId: string, warehouseId: string, qty: number, rate: number, brandId: string | null = null) =>
          recordMovement(tx, { itemId, warehouseId, transactionType: 'PURCHASE', direction: 'IN', qty, unitRate: rate, referenceType: 'ZZTEST_IN', referenceId: `zz-${stamp}-${++ref}`, brandId })
        const take = (itemId: string, warehouseId: string, qty: number, brandId: string | null) =>
          recordMovement(tx, { itemId, warehouseId, transactionType: 'ISSUE', direction: 'OUT', qty, referenceType: 'ZZTEST_OUT', referenceId: `zz-${stamp}-${++ref}`, brandId, stickers: 'caller' })
        const share = (itemId: string, warehouseId: string, brandId: string | null) => balanceOf(tx, { itemId, warehouseId, ownership: 'OWNED', brandId })
        const whole = (itemId: string, warehouseId: string) => balanceOf(tx, { itemId, warehouseId, ownership: 'OWNED' })
        const raise = (i: Omit<RaiseInput, 'reason'> & { reason?: string }, maker = admin.id) => raiseReallocation(tx, { reason: 'ZZTEST brand stock', ...i }, maker)
        const byOther = { id: other.id, admin: false }

        // ═══ 1. Decision 5 on the real engine: valuation scenario 2 ═══
        const F1 = await fabric('V')
        await put(F1, S, 1000, 100)
        await put(F1, S, 500, 130, B) // Stich Code's own PO, here brand B's
        const e1 = await raise({ kind: 'EARMARK', warehouseId: S, fromBrandId: null, toBrandId: A, lines: [{ itemId: F1, qty: 400 }] })
        await approveReallocation(tx, e1.id, byOther)
        const issuedA = await take(F1, S, 300, A)
        const issuedB = await take(F1, S, 400, B)
        const [c1, a1, b1, w1] = await Promise.all([share(F1, S, null), share(F1, S, A), share(F1, S, B), whole(F1, S)])
        check('decision 5: A’s 300 m issued at its own ₹100 (₹30,000), B’s 400 m at ₹130 (₹52,000) — the simulator’s figures', r2(300 * issuedA.unitRate) === 30000 && r2(400 * issuedB.unitRate) === 52000, { a: issuedA.unitRate, b: issuedB.unitRate })
        check('…closing: central ₹60,000, A ₹10,000, B ₹13,000; the company ₹83,000 for 800 m', c1.value === 60000 && a1.value === 10000 && b1.value === 13000 && w1.value === 83000 && w1.qty === 800, { c1, a1, b1, w1 })
        check('…against one average per balance (₹88,000 closing), the company carries ₹5,000 less and issued ₹5,000 more: timing only', r2(88000 - w1.value) === 5000 && r2(30000 + 52000 - 77000) === 5000)

        // ═══ 2. Decision 8: maker-checker, override, moves and averages ═══
        const F2 = await fabric('M')
        await put(F2, S, 200, 50)
        const e2 = await raise({ kind: 'EARMARK', warehouseId: S, fromBrandId: null, toBrandId: A, lines: [{ itemId: F2, qty: 50 }] })
        check(`raised and waiting: ${e2.number}`, e2.status === 'PENDING' && /^SRA-\d{4}-\d{4}$/.test(e2.number), e2.number)
        await refuses('its maker cannot approve it', () => approveReallocation(tx, e2.id, { id: admin.id, admin: false }), 'SELF_APPROVAL')
        await refuses('an Admin approving their own without a reason is refused', () => approveReallocation(tx, e2.id, { id: admin.id, admin: true }, 'too short'), 'OVERRIDE_REASON_REQUIRED')
        const before2 = await whole(F2, S)
        await approveReallocation(tx, e2.id, { id: admin.id, admin: true }, 'ZZTEST: the cutting master needs it tonight')
        const e2r = await tx.stockReallocation.findUniqueOrThrow({ where: { id: e2.id } })
        check('an Admin’s own, with a reason: posted, marked as an override, the reason kept', e2r.status === 'POSTED' && e2r.selfApproved && e2r.overrideReason === 'ZZTEST: the cutting master needs it tonight', e2r)
        const after2 = await whole(F2, S)
        check('an earmark leaves the company’s stock and value as they were', after2.qty === before2.qty && after2.value === before2.value, { before2, after2 })
        check('central 150, A 50 at central’s ₹50', (await share(F2, S, null)).qty === 150 && (await share(F2, S, A)).value === 2500)
        const m2 = await raise({ kind: 'MOVE', warehouseId: S, fromBrandId: A, toBrandId: B, lines: [{ itemId: F2, qty: 20 }] })
        await approveReallocation(tx, m2.id, byOther)
        check('a move between brands at the giving brand’s average: B 20 at ₹50', (await share(F2, S, B)).value === 1000 && (await share(F2, S, A)).qty === 30)
        const rl2 = await raise({ kind: 'RELEASE', warehouseId: S, fromBrandId: B, toBrandId: null, lines: [{ itemId: F2, qty: 20 }] }, other.id)
        await approveReallocation(tx, rl2.id, { id: admin.id, admin: true })
        check('a release back to central', (await share(F2, S, B)).qty === 0 && (await share(F2, S, null)).qty === 170)
        await put(F2, S, 100, 80)
        const [c2, a2] = await Promise.all([share(F2, S, null), share(F2, S, A)])
        check('central bought at ₹80: central’s average moves (₹61.11), A’s stays ₹50 — each share its own', c2.avgRate === 61.11 && a2.avgRate === 50, { c2, a2 })
        const rj = await raise({ kind: 'EARMARK', warehouseId: S, fromBrandId: null, toBrandId: B, lines: [{ itemId: F2, qty: 10 }] }, other.id)
        await refuses('its maker refuses nothing: withdraws instead', () => rejectReallocation(tx, rj.id, other.id, 'ZZTEST not needed'), 'OWN_REJECT')
        await rejectReallocation(tx, rj.id, admin.id, 'ZZTEST not needed')
        check('refused by someone else: nothing moved', (await tx.stockReallocation.findUniqueOrThrow({ where: { id: rj.id } })).status === 'REJECTED' && (await share(F2, S, B)).qty === 0)
        const wd = await raise({ kind: 'EARMARK', warehouseId: S, fromBrandId: null, toBrandId: B, lines: [{ itemId: F2, qty: 10 }] })
        await cancelReallocation(tx, wd.id, { id: admin.id, admin: true })
        check('withdrawn by its maker', (await tx.stockReallocation.findUniqueOrThrow({ where: { id: wd.id } })).status === 'CANCELLED')

        // ═══ 3. Holds, customer material, central only by default ═══
        const dept = await tx.department.findFirstOrThrow({ select: { id: true } })
        const holdFor = async (qty: number) => {
          const mr = await tx.materialRequisition.create({
            data: { mrNumber: `ZZBSH${stamp}${++ref}`, departmentId: dept.id, status: 'APPROVED', raisedById: other.id, approvedById: other.id, lines: { create: [{ itemId: F2, requestedQty: qty, warehouseId: S, ownership: 'OWNED' }] } },
            include: { lines: true },
          })
          await tx.stockReservation.create({ data: { mrId: mr.id, mrLineId: mr.lines[0].id, itemId: F2, warehouseId: S, reservedQty: qty, qty, status: 'ACTIVE' } })
        }
        await holdFor(200) // central F2 270: 70 free
        await refuses('an earmark of held stock is refused at once (70 free of 270)', () => raise({ kind: 'EARMARK', warehouseId: S, fromBrandId: null, toBrandId: B, lines: [{ itemId: F2, qty: 100 }] }), 'NOT_ENOUGH_IN_SHARE')
        const late = await raise({ kind: 'EARMARK', warehouseId: S, fromBrandId: null, toBrandId: B, lines: [{ itemId: F2, qty: 60 }] })
        await holdFor(20) // now 50 free
        await refuses('…and at approval, when a hold came after it was raised', () => approveReallocation(tx, late.id, byOther), 'RESERVED_STOCK')
        await refuses('a customer’s material is never a brand’s', () => recordMovement(tx, { itemId: F2, warehouseId: S, ownership: 'CUSTOMER_OWNED', ownerCustomerId: customer.id, transactionType: 'CUSTOMER_MATERIAL', direction: 'IN', qty: 1, unitRate: 0, referenceType: 'ZZTEST_IN', referenceId: `zz-${stamp}-cust`, brandId: A }), 'CUSTOMER_STOCK_NO_BRAND')
        await refuses('…and the database refuses one too', () => tx.$executeRawUnsafe(`INSERT INTO ld_erp.stock_ledger (id, "itemId", "warehouseId", "transactionType", ownership, "ownerCustomerId", "inQty", "outQty", "closingStock", "brandId") VALUES ('zz-${stamp}-x', '${F2}', '${S}', 'CUSTOMER_MATERIAL', 'CUSTOMER_OWNED', '${customer.id}', 1, 0, 1, '${A}')`).catch((e) => Promise.reject({ code: /brand_only_owned/.test(String(e)) ? 'CHECK' : 'OTHER', message: String(e) })), 'CHECK')
        // F1: central 600, A 100, B 100 — an issue naming no brand takes central only.
        await refuses('with no brand named, only central stock is taken — and the refusal says whose the rest is', () => take(F1, S, 700, null), 'STOCK_EARMARKED')
        check('a count sees the whole stock: 800 m of F1, every share together', (await whole(F1, S)).qty === 800)

        // ═══ 4. Stickers: a part of a roll earmarked ═══
        const F3 = await fabric('R')
        await put(F3, S, 100, 40)
        const rolls = await createPackages(tx, { spot: { itemId: F3, warehouseId: S, ownership: 'OWNED', ownerCustomerId: null }, packType: 'ROLL', qtys: [60, 40], lotNo: `LOT${stamp}`, sourceType: 'STOCK', userId: admin.id, unit: 'm', itemName: 'ZZTEST' })
        const unnamed = await raise({ kind: 'EARMARK', warehouseId: S, fromBrandId: null, toBrandId: A, lines: [{ itemId: F3, qty: 25 }] })
        await refuses('all of it on rolls: the earmark must name the rolls', () => approveReallocation(tx, unnamed.id, byOther), 'STICKERS_NEEDED')
        const part = await raise({ kind: 'EARMARK', warehouseId: S, fromBrandId: null, toBrandId: A, lines: [{ itemId: F3, qty: 25, packageCodes: [rolls[0].code] }] })
        await approveReallocation(tx, part.id, byOther)
        const roll = await tx.stockPackage.findUniqueOrThrow({ where: { id: rolls[0].id } })
        const child = await tx.stockPackage.findFirst({ where: { parentId: roll.id, brandId: A, status: 'IN_STOCK' } })
        check('25 m of a 60 m roll: the roll keeps its sticker with 35 m, central', Number(roll.qty) === 35 && roll.brandId === null && roll.status === 'IN_STOCK', roll)
        check('…the 25 m rides on it as a child sticker of A’s, same lot and rack', !!child && Number(child.qty) === 25 && child.lotNo === roll.lotNo && child.rack === roll.rack, child)
        const pos = await sharePositions(tx, { itemId: F3, warehouseId: S, ownership: 'OWNED', ownerCustomerId: null })
        check('stickers agree with the ledger share by share (central 75 = 35 + 40, A 25 = 25)', pos.every((x) => Math.abs(x.loose) < 0.0005) && pos.length === 2, pos)
        const line = await tx.stockReallocationLine.findFirstOrThrow({ where: { reallocationId: part.id } })
        check('the line keeps the sticker that now carries the earmark', line.packageCodes.length === 1 && line.packageCodes[0] === child?.code, line.packageCodes)
        await reverseReallocation(tx, part.id, admin.id, 'ZZTEST put back')
        const childBack = await tx.stockPackage.findUnique({ where: { id: child!.id } })
        check('reversed: the child sticker is central again and A holds nothing', childBack?.brandId === null && (await share(F3, S, A)).qty === 0 && (await share(F3, S, null)).qty === 100)

        // ═══ 5. Decision 7: an MO's issue ═══
        let found: { mo: { id: string; moNumber: string }; itemId: string; room: number; departmentId: string | null } | null = null
        const mos = await tx.manufacturingOrder.findMany({ where: { status: { notIn: ['COMPLETED', 'CLOSED'] }, NOT: { brand: { name: { contains: 'VHAGAR', mode: 'insensitive' } } } }, select: { id: true, moNumber: true }, take: 25 })
        for (const mo of mos) {
          const plan = await materialPlan(tx, mo.id)
          const row = plan.rows.find((r) => r.ownership === 'OWNED' && r.required - r.issued >= 12 && r.item.places === 0) ?? plan.rows.find((r) => r.ownership === 'OWNED' && r.required - r.issued >= 12)
          if (row) {
            found = { mo, itemId: row.item.id, room: Math.round((row.required - row.issued) * 1000) / 1000, departmentId: row.department?.id ?? null }
            break
          }
        }
        if (!found) check('an MO on the demo with material still to issue', false)
        else {
          const { mo, itemId: I, room } = found
          await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { brandId: A, status: 'RELEASED', heldAt: null, holdReason: null } })
          await put(I, S, 100, 20)
          const mr = await tx.materialRequisition.create({
            data: { mrNumber: `ZZBSI${stamp}`, moId: mo.id, departmentId: found.departmentId ?? dept.id, status: 'APPROVED', raisedById: other.id, approvedById: other.id, lines: { create: [{ itemId: I, requestedQty: room + 5, warehouseId: S, ownership: 'OWNED' }] } },
            include: { lines: true },
          })
          const lineId = mr.lines[0].id
          const issue = (qty: number) => issueRequisition(tx, mr.id, { lines: [{ lineId, issueQty: qty, warehouseId: S }] }, asAdmin as never)
          await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { status: 'DRAFT' } })
          await refuses(`${mo.moNumber} as a draft: central stock does not move to it`, () => issue(5), 'MO_NOT_AUTHORISED')
          await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { status: 'RELEASED', heldAt: new Date(), holdReason: 'ZZTEST buyer query' } })
          await refuses('on hold: nor then', () => issue(5), 'MO_ON_HOLD')
          await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { status: 'COMPLETED', heldAt: null, holdReason: null } })
          await refuses('completed: nor then', () => issue(5), 'MO_NOT_AUTHORISED')
          await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { status: 'CUTTING' } })
          // Past what the MO may use (plan + approved extras): refused before any share is looked at (28 Nov 2026).
          await refuses(`more than it still needs (${room} left): refused, extra material asked for instead`, () => issue(room + 5), 'EXTRA_NEEDED')
          const r10 = await issue(10)
          const auto1 = await tx.stockReallocation.findFirst({ where: { mrId: mr.id, kind: 'AUTO' }, include: { lines: true } })
          check(`authorised, within need: 10 issued, central moved to A by itself (${auto1?.number})`, r10.autoMoved.length === 1 && auto1?.status === 'POSTED' && Number(auto1.lines[0].qty) === 10 && auto1.moId === mo.id && auto1.toBrandId === A, { autoMoved: r10.autoMoved, auto1 })
          const issueRow = await tx.stockLedger.findFirst({ where: { referenceType: 'MATERIAL_REQUISITION', referenceId: mr.id }, orderBy: { createdAt: 'desc' } })
          check('the issue itself leaves A’s share, carrying the MO’s brand', issueRow?.brandId === A && Number(issueRow.outQty) === 10, issueRow)
          check('central 90, A nothing left after the issue', (await share(I, S, null)).qty === 90 && (await share(I, S, A)).qty === 0)
          const own = await raise({ kind: 'EARMARK', warehouseId: S, fromBrandId: null, toBrandId: A, lines: [{ itemId: I, qty: 4 }] })
          await approveReallocation(tx, own.id, byOther)
          await issue(6)
          const autos = await tx.stockReallocation.findMany({ where: { mrId: mr.id, kind: 'AUTO' }, include: { lines: true }, orderBy: { createdAt: 'asc' } })
          check('A’s own 4 first, then only 2 from central', autos.length === 2 && Number(autos[1].lines[0].qty) === 2 && (await share(I, S, null)).qty === 84, autos.map((x) => Number(x.lines[0].qty)))
          const toB = await raise({ kind: 'EARMARK', warehouseId: S, fromBrandId: null, toBrandId: B, lines: [{ itemId: I, qty: 84 }] })
          await approveReallocation(tx, toB.id, byOther)
          await refuses('central gone, the rest B’s: A’s order never takes B’s earmark', () => issue(1), 'STOCK_EARMARKED')
          const back = await returnFromFloor(tx, mr.id, { lines: [{ lineId, qty: 3, warehouseId: S }], reason: 'ZZTEST unused' }, admin.id)
          const fl = await tx.floorReturnLine.findMany({ where: { returnId: back.returnId } })
          check('back from the floor: into A’s share, at its issue rate', fl.length === 1 && fl[0].brandId === A && (await share(I, S, A)).value === 60, { fl, a: await share(I, S, A) })
          await cancelFloorReturn(tx, back.returnId, 'ZZTEST entered by mistake', admin.id)
          check('the return cancelled: out of A’s share again', (await share(I, S, A)).qty === 0)

          // Stickers through an MO's issue: central rolls of 30 and 20 of the same material.
          if (room >= 30) {
            await put(I, S, 50, 20)
            const spot = { itemId: I, warehouseId: S, ownership: 'OWNED' as const, ownerCustomerId: null }
            const [r30, r20] = await createPackages(tx, { spot, packType: 'ROLL', qtys: [30, 20], lotNo: `LOTI${stamp}`, sourceType: 'STOCK', userId: admin.id, unit: '', itemName: 'ZZTEST' })
            await issue(5)
            const carried = await tx.stockPackage.findFirst({ where: { parentId: r30.id, brandId: A } })
            let pos = await sharePositions(tx, spot)
            const posOf = (b: string | null) => pos.find((x) => x.brandId === b)
            check('a typed issue: the oldest central roll’s 5 moved to A with it, as a child sticker', !!carried && Number(carried.qty) === 5 && Math.abs(posOf(null)?.loose ?? 1) < 0.0005, { carried, pos })
            check('…A’s sticker waits for the labels window, as any typed issue’s does', Math.abs((posOf(A)?.loose ?? 0) + 5) < 0.0005, pos)
            await takeFromPackage(tx, carried!, 5, { notes: 'ZZTEST labels window', userId: admin.id, referenceType: 'MATERIAL_REQUISITION', referenceId: mr.id })
            pos = await sharePositions(tx, spot)
            // No share's stickers claim more than its ledger; the rolled shares (central, A) agree exactly. B's earmark has no rolls.
            const agree = () => pos.every((x) => x.loose > -0.0005) && Math.abs(posOf(null)?.loose ?? 1) < 0.0005 && Math.abs(posOf(A)?.loose ?? 0) < 0.0005
            check('…and once the window takes it down, every share agrees', agree(), pos)
            await issueRequisition(tx, mr.id, { lines: [{ lineId, issueQty: 4, warehouseId: S }] }, asAdmin as never, { stickers: 'caller', fromShare: null })
            await takeFromPackage(tx, r20, 4, { notes: 'ZZTEST scanned', userId: admin.id, referenceType: 'MATERIAL_REQUISITION', referenceId: mr.id })
            pos = await sharePositions(tx, spot)
            check('a scanned central roll: 4 moved to A and issued, its sticker down by 4; every share agrees', agree() && (await share(I, S, A)).qty === 0, pos)
            await refuses('a scanned roll of another brand’s earmark is refused', () => issueRequisition(tx, mr.id, { lines: [{ lineId, issueQty: 1, warehouseId: S }] }, asAdmin as never, { stickers: 'caller', fromShare: B }), 'OTHER_BRANDS_STOCK')
          } else check('(the MO found needs too little more for the sticker checks)', true)
        }

        // ═══ 6. Transfers move a share as itself ═══
        const centralBefore = await share(F1, S, null)
        await createTransfer(tx, { fromWarehouseId: S, toWarehouseId: T, lines: [{ itemId: F1, qty: 50, ownership: 'OWNED', brandId: A }] } as never, admin.id)
        const [aS, aT] = await Promise.all([share(F1, S, A), share(F1, T, A)])
        check('A’s 50 m moved to the other store as A’s, at ₹100; central untouched', aS.qty === 50 && aT.qty === 50 && aT.value === 5000 && (await share(F1, S, null)).qty === centralBefore.qty, { aS, aT })
        const transit = await tx.warehouse.findFirst({ where: { kind: 'TRANSIT', isActive: true }, select: { id: true } })
        if (transit) {
          const tr = await createTransfer(tx, { fromWarehouseId: S, toWarehouseId: T, mode: 'IN_TRANSIT', transitWarehouseId: transit.id, lines: [{ itemId: F1, qty: 20, ownership: 'OWNED', brandId: A }] } as never, admin.id)
          check('in transit: on the road as A’s', (await share(F1, transit.id, A)).qty === 20)
          await receiveTransfer(tx, tr.id, { lines: [{ lineId: tr.lines[0].id, qty: 20 }] }, admin.id)
          const aT2 = await share(F1, T, A)
          check('received: A’s 70 m there at ₹100, nothing left on the road', aT2.qty === 70 && aT2.value === 7000 && (await share(F1, transit.id, A)).qty === 0, aT2)
        } else check('(no transit store on the demo: in-transit part skipped)', true)

        // ═══ 7. Reconciliation, share by share ═══
        const recon = (await stockReconciliation.run({ tx, params: {}, rowCap: 5000 } as never)) as { rows: Array<Record<string, unknown>> }
        check('Stock Reconciliation finds nothing, share by share', recon.rows.length === 0, recon.rows.slice(0, 5))

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
