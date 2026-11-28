import { prisma } from '../packages/database/src/index'
import { createSalesOrderSchema, prepareOrder } from '../apps/api/src/routes/sales.routes'
import { createMo, createMoSchema } from '../apps/api/src/routes/production.routes'
import { createFgReceipt, createSchema as fgSchema } from '../apps/api/src/routes/finishedGoods.routes'
import { issueRequisition, reserveForRequisition } from '../apps/api/src/routes/inventory.routes'
import { cancelChallan, dispatchChallan, loadOpenOrder, writeChallan } from '../apps/api/src/routes/challan.routes'
import { createInvoice, invoiceSchema } from '../apps/api/src/routes/invoice.routes'
import { cancelCreditNote, createCreditNote, creditNoteSchema } from '../apps/api/src/routes/creditNote.routes'
import { addCartonToChallan, packCarton } from '../apps/api/src/services/fgCarton.service'
import { approveReallocation, billLineShare, purchaseShareOf, raiseReallocation } from '../apps/api/src/services/brandStock.service'
import { approveExtra, raiseExtra } from '../apps/api/src/services/materialExtra.service'
import { materialPlan } from '../apps/api/src/services/manufacturing.service'
import { approveAdjustmentIn, brandLosses } from '../apps/api/src/services/stockAdjustment.service'
import { balanceOf, recordMovement } from '../apps/api/src/services/stock.service'
import { profitAndLoss } from '../apps/api/src/services/accounts/finalAccounts.service'
import { booksSettings, todayIst } from '../apps/api/src/services/accounts/books.service'
import { stockReconciliation } from '../apps/api/src/reports/definitions/stock-reconciliation'

/**
 * Multi-brand phase 5, part 2, and phase 6 — every document on the brand
 * shares, each followed by its reversal, with the reconciliation after each.
 *
 *   1. Extra material (the user's rule, 28 Nov 2026): an MO is issued no more
 *      of a material than its plan allows unless a production manager other
 *      than whoever asked approves an extra; an approved earmark alone never
 *      allows it. Within what is permitted, decision 7 moves central stock to
 *      the MO's brand by itself; a material the plan does not call for needs
 *      an extra too. The plan shows the extra.
 *   2. Holds: on the MO brand's own earmark when it covers them, else central;
 *      a requisition with no MO holds central only.
 *   3. Finished goods come in on the MO's brand.
 *   4. A challan sends the order's brand first, then free central stock moved
 *      to it on an automatic reallocation for the challan; another brand's
 *      earmark is never sent; cancelling puts the move back.
 *   5. Cartons seal one share's pieces; a central carton on the challan goes
 *      over to the order's brand with its pieces. Tagged pieces must be
 *      scanned; the tags go over too.
 *   6. A sales return comes back on the order's brand; its cancellation takes
 *      it out of the same share.
 *   7. Counts: a gain is central; a shortage comes from central first, the
 *      approver seeing any brand that loses stock.
 *   8. Purchases: the PO's brand, else the indent's MO brand, else the style's
 *      own brand, else central — for the GRN and its bill alike.
 *   9. Phase 6: an earmark changes no brand's profit; the brands and Not split
 *      add up to the company; transfers in and out cancel.
 *  10. Stock Reconciliation after every step finds nothing on these items.
 *
 * ZZTEST stores and items, inside one transaction that always throws: nothing
 * is kept. Demo database (lderp_demo) only. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   npx tsx ../../tools/check-brand-documents.ts
 */

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 900)}` : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const stamp = Date.now().toString(36).slice(-5).toUpperCase()
const r2 = (n: number) => Math.round(n * 100) / 100
const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol

async function main() {
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== 'lderp_demo') {
    console.error('Refusing to run: not lderp_demo.')
    process.exitCode = 2
    return
  }
  const admin = await prisma.user.findFirstOrThrow({ where: { role: { name: { in: ['Super Admin', 'Admin'] } } }, select: { id: true, name: true } })
  const other = await prisma.user.findFirstOrThrow({ where: { id: { not: admin.id } }, select: { id: true } })
  const asAdmin = { id: admin.id, email: '', name: admin.name, roleId: '', role: 'Super Admin', superAdmin: true, permissions: [] } as never
  const company = await prisma.company.findFirstOrThrow({ select: { id: true } })
  const LD = await prisma.brand.findFirstOrThrow({ where: { isActive: true, isDefault: true }, select: { id: true, name: true } })
  const cust = await prisma.customer.findFirstOrThrow({ where: { isActive: true, isBlacklisted: false, OR: [{ shippingStateCode: { not: null } }, { billingStateCode: { not: null } }] }, select: { id: true } })
  const fabricTemplate = await prisma.item.findUniqueOrThrow({ where: { code: 'FAB-COT-001' } })
  const fgTemplate = await prisma.item.findUniqueOrThrow({ where: { code: 'FG-SHRT-001' } })
  const style = await prisma.style.findUniqueOrThrow({ where: { code: 'LD-SH-2601' }, include: { sizeGroup: { include: { sizes: true } } } })
  const cutting = await prisma.department.findFirstOrThrow({ where: { name: 'Cutting' }, select: { id: true } })
  const [S1, S2] = [...style.sizeGroup!.sizes].sort((a, b) => a.sequence - b.sequence)

  try {
    await prisma.$transaction(
      async (tx) => {
        /** Expected to be refused with this code; nothing it did is kept. */
        const refuses = async (label: string, run: () => Promise<unknown>, code: string) => {
          await tx.$executeRawUnsafe('SAVEPOINT refused')
          try {
            await run()
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT refused')
            check(label, false, 'was allowed')
          } catch (e) {
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refused')
            const c = (e as { code?: string }).code
            check(label, c === code, { code: c, message: (e as Error).message })
            return (e as Error).message
          }
          return ''
        }
        const shareOf = async (itemId: string, warehouseId: string, brandId: string | null, sizeId: string | null = null) =>
          balanceOf(tx, { itemId, warehouseId, ownership: 'OWNED', sizeId, grade: 'A', brandId })
        const ours: string[] = []
        const reconciled = async (step: string) => {
          const recon = (await stockReconciliation.run({ tx, params: {}, rowCap: 5000 } as never)) as { rows: Array<Record<string, unknown>> }
          const names = new Set((await tx.item.findMany({ where: { id: { in: ours } }, select: { name: true } })).map((i) => i.name))
          const mine = recon.rows.filter((r) => names.has(String(r.item)))
          check(`reconciled after ${step}: stickers, tags, cartons, holds and values agree with every share`, mine.length === 0, mine)
        }

        // ── Masters ──
        const C = await tx.brand.create({ data: { companyId: company.id, name: `ZZTEST BD Other ${stamp}`, type: 'LD_COTTON_MILLS' }, select: { id: true, name: true } })
        const store = async (tag: string, kind: 'GENERAL' | 'FINISHED_GOODS') =>
          (await tx.warehouse.create({ data: { companyId: company.id, name: `ZZTEST BD ${tag} ${stamp}`, code: `ZZBD${tag}${stamp}`, kind }, select: { id: true } })).id
        const FAB = await store('FAB', 'GENERAL')
        const FGS = await store('FGS', 'FINISHED_GOODS')
        const fabric = (await tx.item.create({ data: { code: `ZZBDF${stamp}`, name: `ZZTEST BD fabric ${stamp}`, type: 'RAW_MATERIAL', categoryId: fabricTemplate.categoryId, uomId: fabricTemplate.uomId }, select: { id: true } })).id
        const thread = (await tx.item.create({ data: { code: `ZZBDT${stamp}`, name: `ZZTEST BD thread ${stamp}`, type: 'TRIM', categoryId: fabricTemplate.categoryId, uomId: fabricTemplate.uomId }, select: { id: true } })).id
        const color = `ZZ BD ${stamp}`
        await tx.style.update({ where: { id: style.id }, data: { colors: { push: color } } })
        const taxRateId = fgTemplate.taxRateId ?? (await tx.taxRate.findFirstOrThrow({ where: { rate: 5 } })).id
        const fg = (
          await tx.item.create({
            data: { code: `ZZBDG${stamp}`, name: `ZZTEST BD shirt ${stamp}`, type: 'FINISHED_GOOD', categoryId: fgTemplate.categoryId, uomId: fgTemplate.uomId, styleId: style.id, color, standardRate: 250, hsnCode: fgTemplate.hsnCode ?? '6205', taxRateId },
            select: { id: true },
          })
        ).id
        ours.push(fabric, thread, fg)
        // The BOM: 1.5 m of the fabric a shirt, given to Cutting.
        await tx.bOM.create({
          data: { styleId: style.id, color, version: '1.0', status: 'APPROVED', approvedById: admin.id, approvedAt: new Date(), lines: { create: [{ componentItemId: fabric, departmentId: cutting.id, qtyPerUnit: 1.5, effectiveQty: 1.5 }] } },
        })
        const ref = (n: string) => ({ referenceType: 'ZZTEST_OPENING', referenceId: `zzbd-${n}-${stamp}` })

        // ── The order and its MO: 20 shirts, so 30 m of fabric on the plan ──
        const { header, lines } = await prepareOrder(
          tx,
          createSalesOrderSchema.parse({ customerId: cust.id, brandId: LD.id, customerPORef: `ZZBD-${stamp}`, lines: [{ itemId: fg, color, totalQty: 40, unitPrice: 420, sizes: [{ sizeId: S1.id, qty: 25 }, { sizeId: S2.id, qty: 15 }] }] }),
        )
        const so = await tx.salesOrder.create({ data: { ...header, soNumber: `ZZ-BDSO-${stamp}`, status: 'CONFIRMED', createdById: admin.id, lines: { create: lines } }, include: { lines: true } })
        const mo = await createMo(tx, createMoSchema.parse({ soId: so.id, release: true, lines: [{ soLineId: so.lines[0].id, sizes: [{ sizeId: S1.id, qty: 10 }, { sizeId: S2.id, qty: 10 }] }] }), admin.id)
        check(`the order is ${LD.name}'s; its MO released with 30 m of fabric on the plan`, so.brandId === LD.id && mo.brandId === LD.id && mo.status === 'RELEASED')

        // ═══ 1. Extra material and decision 7 ═══
        await recordMovement(tx, { itemId: fabric, warehouseId: FAB, transactionType: 'PURCHASE', direction: 'IN', qty: 100, unitRate: 100, ...ref('fab') })
        await recordMovement(tx, { itemId: thread, warehouseId: FAB, transactionType: 'PURCHASE', direction: 'IN', qty: 50, unitRate: 10, ...ref('thr') })
        const mr = async (itemId: string, qty: number, n: string) =>
          tx.materialRequisition.create({
            data: { mrNumber: `ZZ-BDMR-${n}-${stamp}`, moId: mo.id, soId: so.id, departmentId: cutting.id, status: 'APPROVED', lines: { create: [{ itemId, requestedQty: qty, warehouseId: FAB }] } },
            include: { lines: true },
          })
        const issue = (m: { id: string; lines: Array<{ id: string }> }, qty: number) => issueRequisition(tx, m.id, { lines: [{ lineId: m.lines[0].id, issueQty: qty, warehouseId: FAB }] }, asAdmin)
        const mr1 = await mr(fabric, 30, '1')
        await issue(mr1, 30)
        const auto1 = await tx.stockReallocation.findFirst({ where: { mrId: mr1.id, kind: 'AUTO' }, include: { lines: true } })
        check('within the plan: 30 m issued, central stock moved to the brand by itself (decision 7)', !!auto1 && Number(auto1.lines[0].qty) === 30 && auto1.toBrandId === LD.id && (await shareOf(fabric, FAB, null)).qty === 70)
        const mr2 = await mr(fabric, 5, '2')
        await refuses('5 m more than the plan: refused, the extra has to be approved', () => issue(mr2, 5), 'EXTRA_NEEDED')
        const ear = await raiseReallocation(tx, { kind: 'EARMARK', warehouseId: FAB, fromBrandId: null, toBrandId: LD.id, moId: mo.id, reason: 'ZZTEST earmark for the brand', lines: [{ itemId: fabric, qty: 10 }] }, admin.id)
        await approveReallocation(tx, ear.id, { id: other.id, admin: false })
        const why = await refuses(`with 10 m earmarked for ${LD.name} and approved, still refused: an earmark does not allow more`, () => issue(mr2, 5), 'EXTRA_NEEDED')
        check('…the refusal says to ask for extra material, approved by a production manager', /extra material/i.test(why) && /production manager/i.test(why), why)
        const extra = await raiseExtra(tx, mo.id, { itemId: fabric, qty: 5, reason: 'ZZTEST recut after a shade fault' }, admin.id)
        await refuses('the Admin who asked cannot approve it without an override reason', () => approveExtra(tx, extra.id, { id: admin.id, admin: true }), 'OVERRIDE_REASON_REQUIRED')
        await refuses('someone else who asked cannot approve their own at all', async () => {
          const theirs = await raiseExtra(tx, mo.id, { itemId: fabric, qty: 1, reason: 'ZZTEST their own request' }, other.id)
          return approveExtra(tx, theirs.id, { id: other.id, admin: false })
        }, 'SELF_APPROVAL')
        await approveExtra(tx, extra.id, { id: other.id, admin: false })
        await issue(mr2, 5)
        const own = await shareOf(fabric, FAB, LD.id)
        check(`approved by someone else: the 5 m issue goes, from ${LD.name}'s own earmark first (10 → 5)`, own.qty === 5, own)
        const plan = await materialPlan(tx, mo.id)
        const row = plan.rows.find((r) => r.item.id === fabric)
        check('the plan shows the approved extra beside what the BOM needs', row?.required === 30 && row?.extra === 5, row && { required: row.required, extra: row.extra })
        const mr3 = await mr(fabric, 1, '3')
        await refuses('one metre past plan + extra: refused again', () => issue(mr3, 1), 'EXTRA_NEEDED')
        const mrT = await mr(thread, 4, 'T')
        const said = await refuses('thread the plan does not call for: refused', () => issue(mrT, 4), 'EXTRA_NEEDED')
        check('…saying the plan does not call for it', /does not call for/.test(said), said)
        const ex2 = await raiseExtra(tx, mo.id, { itemId: thread, qty: 4, reason: 'ZZTEST buttons need thread' }, other.id)
        await approveExtra(tx, ex2.id, { id: admin.id, admin: true })
        await issue(mrT, 4)
        const autoT = await tx.stockReallocation.findFirst({ where: { mrId: mrT.id, kind: 'AUTO' }, include: { lines: true } })
        check('approved as extra: the thread is issued, central stock moving to the brand within it', !!autoT && Number(autoT.lines[0].qty) === 4)
        await reconciled('the issues')

        // ═══ 2. Holds ═══
        const mrH = await tx.materialRequisition.create({
          data: { mrNumber: `ZZ-BDMR-H-${stamp}`, moId: mo.id, soId: so.id, departmentId: cutting.id, status: 'APPROVED', lines: { create: [{ itemId: fabric, requestedQty: 30, warehouseId: FAB }] } },
          include: { lines: true },
        })
        await reserveForRequisition(tx, mrH.id, { lines: [{ lineId: mrH.lines[0].id, warehouseId: FAB, qty: 4 }] }, admin.id)
        let hold = await tx.stockReservation.findFirst({ where: { mrLineId: mrH.lines[0].id, status: 'ACTIVE' } })
        check(`a hold the brand's own earmark covers sits on it (${LD.name}, 4 of its 5 m)`, hold?.brandId === LD.id && Number(hold?.qty) === 4, hold)
        await reserveForRequisition(tx, mrH.id, { lines: [{ lineId: mrH.lines[0].id, warehouseId: FAB, qty: 20 }] }, admin.id)
        hold = await tx.stockReservation.findFirst({ where: { mrLineId: mrH.lines[0].id, status: 'ACTIVE' } })
        check('raised to 20 m, more than the earmark: the hold moves to free central stock', hold?.brandId === null && Number(hold?.qty) === 20, hold)
        const general = await tx.materialRequisition.create({
          data: { mrNumber: `ZZ-BDMR-G-${stamp}`, departmentId: cutting.id, status: 'APPROVED', lines: { create: [{ itemId: fabric, requestedQty: 60, warehouseId: FAB }] } },
          include: { lines: true },
        })
        await refuses('a requisition with no MO cannot hold more than central has free (65 − 20 held = 45)', () => reserveForRequisition(tx, general.id, { lines: [{ lineId: general.lines[0].id, warehouseId: FAB, qty: 50 }] }, admin.id), 'NOT_ENOUGH_FREE')
        await refuses(`an earmark cannot take stock held for a requisition`, () => raiseReallocation(tx, { kind: 'EARMARK', warehouseId: FAB, fromBrandId: null, toBrandId: C.id, reason: 'ZZTEST', lines: [{ itemId: fabric, qty: 50 }] }, admin.id), 'NOT_ENOUGH_IN_SHARE')
        await reconciled('the holds')

        // ═══ 3. Finished goods come in on the MO's brand ═══
        const fgr = await createFgReceipt(tx, fgSchema.parse({ warehouseId: FGS, moId: mo.id, lines: [{ itemId: fg, sizeId: S1.id, qty: 10 }, { itemId: fg, sizeId: S2.id, qty: 10 }] }), admin.id)
        const fgRows = await tx.stockLedger.findMany({ where: { referenceType: 'FG_RECEIPT', referenceId: fgr.id } })
        check(`the FG receipt is ${LD.name}'s: its rows and the receipt carry the brand`, fgr.brandId === LD.id && fgRows.length === 2 && fgRows.every((r) => r.brandId === LD.id))
        const rate = Number(fgRows[0].unitRate)
        const fgLineS1 = (await tx.finishedGoodsReceiptLine.findFirstOrThrow({ where: { receiptId: fgr.id, sizeId: S1.id }, select: { id: true } })).id
        // Central finished stock (from before brands had shares), and some of it another brand's.
        await recordMovement(tx, { itemId: fg, warehouseId: FGS, sizeId: S1.id, transactionType: 'OPENING', direction: 'IN', qty: 6, unitRate: 200, ...ref('fg1') })
        const earC = await raiseReallocation(tx, { kind: 'EARMARK', warehouseId: FGS, fromBrandId: null, toBrandId: C.id, reason: 'ZZTEST pieces for the other brand', lines: [{ itemId: fg, sizeId: S1.id, qty: 2 }] }, admin.id)
        await approveReallocation(tx, earC.id, { id: other.id, admin: false })
        check(`size ${S1.code}: ${LD.name} 10, central 4, ${C.name} 2`, (await shareOf(fg, FGS, LD.id, S1.id)).qty === 10 && (await shareOf(fg, FGS, null, S1.id)).qty === 4 && (await shareOf(fg, FGS, C.id, S1.id)).qty === 2)
        await reconciled('the FG receipt')

        // ═══ 4. Dispatch: the order's brand first, then central, never another brand's ═══
        const order = () => loadOpenOrder(tx, so.id)
        const dc1 = await writeChallan(tx, await order(), { soId: so.id, warehouseId: FGS, lines: [{ soLineId: so.lines[0].id, sizes: [{ sizeId: S1.id, qty: 14 }] }] } as never, null, admin.id)
        await dispatchChallan(tx, dc1.id, admin.id)
        const autoDc = await tx.stockReallocation.findFirst({ where: { dcId: dc1.id }, include: { lines: true } })
        const dcOut = await tx.stockLedger.findMany({ where: { referenceType: 'DELIVERY_CHALLAN', referenceId: dc1.id } })
        check(`14 sent: ${LD.name}'s 10, and central's 4 moved to it first on an automatic reallocation for the challan`, autoDc?.kind === 'AUTO' && autoDc.status === 'POSTED' && Number(autoDc.lines[0].qty) === 4 && autoDc.toBrandId === LD.id && dcOut.every((r) => r.brandId === LD.id) && dcOut.reduce((t, r) => t + Number(r.outQty), 0) === 14)
        check(`…the challan line says whose it went from, and ${C.name}'s 2 are untouched`, (await tx.deliveryChallanLine.findFirst({ where: { dcId: dc1.id } }))?.brandId === LD.id && (await shareOf(fg, FGS, C.id, S1.id)).qty === 2 && (await shareOf(fg, FGS, null, S1.id)).qty === 0)
        const dcX = await writeChallan(tx, await order(), { soId: so.id, warehouseId: FGS, lines: [{ soLineId: so.lines[0].id, sizes: [{ sizeId: S1.id, qty: 1 }] }] } as never, null, admin.id)
        const nope = await refuses(`one more of size ${S1.code}: only ${C.name}'s earmark is left, so it is refused`, () => dispatchChallan(tx, dcX.id, admin.id), 'OTHER_BRANDS_STOCK')
        check('…naming whose it is', nope.includes(C.name), nope)
        await cancelChallan(tx, dcX.id, admin.id, 'ZZTEST not sent')
        await reconciled('the challan')
        await cancelChallan(tx, dc1.id, admin.id, 'ZZTEST wrong vehicle')
        const back = await tx.stockReallocation.findUniqueOrThrow({ where: { id: autoDc!.id } })
        check(`cancelled: ${LD.name} 10 and central 4 again; the automatic move reversed with it`, back.status === 'REVERSED' && (await shareOf(fg, FGS, LD.id, S1.id)).qty === 10 && (await shareOf(fg, FGS, null, S1.id)).qty === 4)
        const lv = await shareOf(fg, FGS, LD.id, S1.id)
        check(`…at the values they left at: ${LD.name} 10 at ₹${rate}, central 4 at ₹200`, near(lv.value, r2(10 * rate)) && near((await shareOf(fg, FGS, null, S1.id)).value, 800), lv)
        await reconciled('the challan cancelled')

        // ═══ 5. Cartons and tags ═══
        const ct1 = await packCarton(tx, { warehouseId: FGS, soId: so.id, lines: [{ itemId: fg, sizeId: S2.id, qty: 5 }] }, admin.id)
        check(`a carton packed for the order seals ${LD.name}'s own pieces`, ct1.carton.brandId === LD.id)
        await recordMovement(tx, { itemId: fg, warehouseId: FGS, sizeId: S2.id, transactionType: 'OPENING', direction: 'IN', qty: 3, unitRate: 200, ...ref('fg2') })
        // For no order, and the brand's own pieces all loose: central, which covers it.
        const ct2 = await packCarton(tx, { warehouseId: FGS, lines: [{ itemId: fg, sizeId: S2.id, qty: 3 }] }, admin.id)
        check('a carton packed for no order, from central stock, is central', ct2.carton.brandId === null)
        const loaded = await addCartonToChallan(tx, { soId: so.id, code: ct1.carton.code }, admin.id)
        await addCartonToChallan(tx, { soId: so.id, dcId: loaded.dcId, code: ct2.carton.code }, admin.id)
        await dispatchChallan(tx, loaded.dcId, admin.id)
        const ct2After = await tx.fgCarton.findUniqueOrThrow({ where: { id: ct2.carton.id } })
        const autoCt = await tx.stockReallocation.findFirst({ where: { dcId: loaded.dcId }, include: { lines: true } })
        check(`both cartons gone; the central one went over to ${LD.name} with its 3 pieces first`, ct2After.status === 'DISPATCHED' && ct2After.brandId === LD.id && Number(autoCt?.lines[0].qty) === 3 && autoCt?.lines[0].packageCodes.includes(ct2.carton.code))
        await reconciled('the cartons')
        // Two of the central size-1 pieces carry tags.
        const tagged = await Promise.all(
          [1, 2].map((n) =>
            tx.garment.create({ data: { code: `ZZBD${stamp}T${n}`, itemId: fg, sizeId: S1.id, grade: 'A', warehouseId: FGS, ownership: 'OWNED', status: 'IN_STOCK', soId: so.id, moId: mo.id, fgReceiptId: fgr.id, fgReceiptLineId: fgLineS1, createdById: admin.id }, select: { id: true, code: true } }),
          ),
        )
        const dcT = await writeChallan(tx, await order(), { soId: so.id, warehouseId: FGS, lines: [{ soLineId: so.lines[0].id, sizes: [{ sizeId: S1.id, qty: 14 }] }] } as never, null, admin.id)
        await refuses('a typed challan taking central pieces that carry tags is refused: scan them', () => dispatchChallan(tx, dcT.id, admin.id), 'TAGS_NEEDED')
        await tx.garment.updateMany({ where: { id: { in: tagged.map((t) => t.id) } }, data: { dcId: dcT.id } })
        await dispatchChallan(tx, dcT.id, admin.id)
        const tagsAfter = await tx.garment.findMany({ where: { id: { in: tagged.map((t) => t.id) } } })
        check(`scanned onto it, the tags go over to ${LD.name} with their pieces and leave with the challan`, tagsAfter.every((g) => g.brandId === LD.id && g.status === 'DISPATCHED'))
        await reconciled('the tagged challan')

        // ═══ 6. A sales return comes back on the order's brand ═══
        const inv = await createInvoice(tx, invoiceSchema.parse({ dcId: dcT.id }), admin.id)
        const invLine = await tx.salesInvoiceLine.findFirstOrThrow({ where: { invoiceId: inv.id } })
        const cn = await createCreditNote(tx, creditNoteSchema.parse({ invoiceId: inv.id, type: 'RETURN', warehouseId: FGS, reason: 'ZZTEST stitching fault', lines: [{ invoiceLineId: invLine.id, sizes: [{ sizeId: S1.id, qty: 3 }] }] }), admin.id)
        const cnRows = await tx.stockLedger.findMany({ where: { referenceType: 'CREDIT_NOTE', referenceId: (cn as { id: string }).id } })
        check(`3 returned: back on ${LD.name}'s share`, cnRows.length > 0 && cnRows.every((r) => r.brandId === LD.id) && cnRows.reduce((t, r) => t + Number(r.inQty), 0) === 3)
        await cancelCreditNote(tx, (cn as { id: string }).id, admin.id, 'ZZTEST entered twice')
        const cnOut = await tx.stockLedger.findMany({ where: { referenceType: 'CREDIT_NOTE_CANCEL', referenceId: (cn as { id: string }).id } })
        check('its cancellation takes them out of the same share', cnOut.length > 0 && cnOut.every((r) => r.brandId === LD.id))
        await reconciled('the sales return')

        // ═══ 7. Counts ═══
        const count = async (diff: number, n: string) =>
          tx.stockAdjustment.create({
            data: { adjustmentNumber: `ZZ-BDADJ-${n}-${stamp}`, warehouseId: FAB, reason: 'ZZTEST count', status: 'PENDING', madeById: other.id, lines: { create: [{ itemId: fabric, bookQty: 0, countedQty: 0, difference: diff, unitRate: 100 }] } },
          })
        const short1 = await count(-8, '1')
        check('a shortage central covers: no brand loses stock', (await brandLosses(tx, short1.id)).length === 0)
        const c0 = await shareOf(fabric, FAB, null)
        await approveAdjustmentIn(tx, short1.id, admin.id, true)
        check('approved: 8 m out of central stock', (await shareOf(fabric, FAB, null)).qty === r2(c0.qty - 8))
        // Central down to nothing (holds released first so the count is not blocked).
        await tx.stockReservation.updateMany({ where: { mrId: mrH.id }, data: { status: 'RELEASED', qty: 0 } })
        const cLeft = (await shareOf(fabric, FAB, null)).qty
        const short2 = await count(-(cLeft + 2), '2')
        const losses = await brandLosses(tx, short2.id)
        check(`a shortage beyond central: the approver sees ${LD.name} lose 2 m`, losses.length === 1 && losses[0].brandId === LD.id && losses[0].qty === 2, losses)
        await approveAdjustmentIn(tx, short2.id, admin.id, true)
        check(`approved: central at nothing, ${LD.name} 3 m (5 − 2)`, (await shareOf(fabric, FAB, null)).qty === 0 && (await shareOf(fabric, FAB, LD.id)).qty === 3)
        const gain = await count(4, '3')
        await approveAdjustmentIn(tx, gain.id, admin.id, true)
        check('a gain goes to central stock', (await shareOf(fabric, FAB, null)).qty === 4 && (await shareOf(fabric, FAB, LD.id)).qty === 3)
        await reconciled('the counts')

        // ═══ 8. Purchases: whose a PO line's goods are ═══
        const supplier = await tx.supplier.findFirstOrThrow({ select: { id: true } })
        const po = async (brandId: string | null, extraLine: Record<string, unknown> = {}) =>
          tx.purchaseOrder.create({
            data: { poNumber: `ZZ-BDPO-${Math.random().toString(36).slice(2, 7)}-${stamp}`, supplierId: supplier.id, brandId, createdById: admin.id, lines: { create: [{ itemId: fabric, qty: 10, unitRate: 100, ...extraLine }] } },
            include: { lines: true },
          })
        const poBrand = await po(C.id)
        check(`a PO with a brand: its goods are ${C.name}'s`, (await purchaseShareOf(tx, poBrand.lines[0].id)) === C.id)
        const poIndent = await po(null, { mrLineId: mr1.lines[0].id })
        check(`no PO brand, bought for the MO's indent: ${LD.name}'s`, (await purchaseShareOf(tx, poIndent.lines[0].id)) === LD.id)
        const poStyle = await po(null, { styleId: style.id })
        check(`no PO brand nor indent, for one of our styles: the style's own brand`, (await purchaseShareOf(tx, poStyle.lines[0].id)) === (await tx.style.findUniqueOrThrow({ where: { id: style.id }, select: { brandId: true } })).brandId)
        const poNone = await po(null)
        check('none of those: central stock', (await purchaseShareOf(tx, poNone.lines[0].id)) === null)
        const grn = await tx.gRN.create({
          data: { grnNumber: `ZZ-BDGRN-${stamp}`, poId: poBrand.id, status: 'ACCEPTED', lines: { create: [{ poLineId: poBrand.lines[0].id, itemId: fabric, warehouseId: FAB, orderedQty: 10, receivedQty: 10, acceptedQty: 10, unitRate: 100, amount: 1000, brandId: C.id }] } },
          include: { lines: true },
        })
        check('a bill line on that GRN line is booked to the GRN line\'s brand', (await billLineShare(tx, { grnLineId: grn.lines[0].id })) === C.id)

        // ═══ 9. Phase 6: an earmark makes no profit or loss for anyone ═══
        const s = await booksSettings(tx)
        if (s.booksStart) {
          const day = todayIst()
          const from = day.slice(0, 8) + '01'
          const before = await profitAndLoss(tx, { from: from < s.booksStart ? s.booksStart : from, to: day }, s)
          await recordMovement(tx, { itemId: fabric, warehouseId: FAB, transactionType: 'PURCHASE', direction: 'IN', qty: 20, unitRate: 150, ...ref('fab2') })
          const pl0 = await profitAndLoss(tx, { from: from < s.booksStart ? s.booksStart : from, to: day }, s)
          const e9 = await raiseReallocation(tx, { kind: 'EARMARK', warehouseId: FAB, fromBrandId: null, toBrandId: LD.id, reason: 'ZZTEST earmark for the P&L', lines: [{ itemId: fabric, qty: 12 }] }, admin.id)
          await approveReallocation(tx, e9.id, { id: other.id, admin: false })
          const pl1 = await profitAndLoss(tx, { from: from < s.booksStart ? s.booksStart : from, to: day }, s)
          const col = (pl: typeof pl1, id: string) => pl.brand.find((b) => b.id === id)
          const centre = (await tx.costCentre.findUnique({ where: { brandId: LD.id }, select: { id: true } }))?.id ?? ''
          const ldBefore = col(pl0, centre)
          const ldAfter = col(pl1, centre)
          const nsBefore = col(pl0, '')
          const nsAfter = col(pl1, '')
          check(`an earmark of 12 m to ${LD.name}: its closing stock rises, and a transfer in of the same value offsets it`, !!ldAfter && !!ldBefore && near(r2((ldAfter.closingStock ?? 0) - (ldBefore.closingStock ?? 0)), r2((ldAfter.transfersIn ?? 0) - (ldBefore.transfersIn ?? 0))), { ldBefore, ldAfter })
          check(`…so ${LD.name}'s gross profit is exactly what it was`, !!ldAfter && !!ldBefore && near(ldAfter.grossProfit, ldBefore.grossProfit), [ldBefore?.grossProfit, ldAfter?.grossProfit])
          check('…and Not split (central stock) too: its transfer out offsets its lower closing stock', !!nsAfter && !!nsBefore && near(nsAfter.grossProfit, nsBefore.grossProfit), [nsBefore?.grossProfit, nsAfter?.grossProfit])
          check('the company’s gross profit does not move with an earmark', near(pl1.grossProfit, pl0.grossProfit), [pl0.grossProfit, pl1.grossProfit])
          const sum = (pl: typeof pl1, k: 'grossProfit' | 'netProfit' | 'transfersIn' | 'transfersOut' | 'closingStock' | 'openingStock') => r2(pl.brand.reduce((t, b) => t + Number(b[k] ?? 0), 0))
          check('the brands and Not split add up to the company: gross and net profit, opening and closing stock', near(sum(pl1, 'grossProfit'), pl1.grossProfit) && near(sum(pl1, 'netProfit'), pl1.netProfit) && near(sum(pl1, 'closingStock'), pl1.closingStock.value) && near(sum(pl1, 'openingStock'), pl1.openingStock.value), { gross: [sum(pl1, 'grossProfit'), pl1.grossProfit], closing: [sum(pl1, 'closingStock'), pl1.closingStock.value] })
          check('transfers in and out cancel across the columns', near(sum(pl1, 'transfersIn'), sum(pl1, 'transfersOut')), [sum(pl1, 'transfersIn'), sum(pl1, 'transfersOut')])
          check('…and with them the period before this test still adds up', near(sum(before, 'grossProfit'), before.grossProfit))
        } else check('the books have a start date (needed for the P&L checks)', false, 'BOOKS_NOT_STARTED')
        await reconciled('everything')
        throw ROLLBACK
      },
      { timeout: 600_000, maxWait: 30_000 },
    )
  } catch (e) {
    if (e !== ROLLBACK) {
      console.error('STOPPED:', e)
      fail++
    }
  }
  console.log(`\n${pass} passed, ${fail} failed — everything the check made has been rolled back`)
  process.exitCode = fail ? 1 : 0
}

main().finally(() => prisma.$disconnect())
