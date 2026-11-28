/**
 * Stock and work in progress reconciled across a realistic manufacturing
 * chain, step by step, and the value each step carries checked to the paisa:
 *
 *   fabric received at two rates (moving average 123.75)
 *   → a requisition issue to the order at that average
 *   → a cutting contractor given fabric, pieces cut into bundles
 *   → cutting → stitching (some damaged, waiting a decision) → packing
 *   → finished goods taken into stock at their cost (the style's approved
 *     BOM costing, else the item's standard rate)
 *   → a delivery challan, then cancelled and dispatched again
 *   and beside it an order without a route, whose cut panels go into stock
 *   at the value of the fabric that went into them, and whose leftover
 *   fabric goes back to the store at the rate it was issued at.
 *
 * After each step: the WIP Reconciliation report's pieces add up (cut = on
 * the floor + waiting + scrapped + packed), what was issued and received is
 * valued as the report says, each store's value is exactly its rows, nothing
 * is left valued at nought quantity, and the Stock Reconciliation report finds
 * nothing new and agrees with the books.
 *
 * Everything runs inside one transaction that always throws: nothing is kept
 * and no number series moves. Demo database (lderp_demo) only, needing the
 * demo masters (style LD-SH-2601 with its size run, FG-SHRT-001,
 * FAB-COT-001, the OP-CUT / OP-STI / OP-PKG processes). From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   npx tsx ../../tools/check-manufacturing-reconciliation.ts
 */
import { prisma } from '../packages/database/src/index'
import { createSalesOrderSchema, prepareOrder } from '../apps/api/src/routes/sales.routes'
import { createMo, createMoSchema } from '../apps/api/src/routes/production.routes'
import { createFgReceipt, createSchema as fgSchema, fgRates } from '../apps/api/src/routes/finishedGoods.routes'
import { issueRequisition, returnFromFloor } from '../apps/api/src/routes/inventory.routes'
import { cancelChallan, dispatchChallan, loadOpenOrder, writeChallan } from '../apps/api/src/routes/challan.routes'
import { createCutting, cuttingSchema, cutterIssueSchema, issueToCutter } from '../apps/api/src/services/cutting.service'
import { dispatch, dispatchSchema, receive, receiveSchema, recordWork, workSchema } from '../apps/api/src/services/floor.service'
import { applyRouting } from '../apps/api/src/services/route.service'
import { balancesOf } from '../apps/api/src/services/wip.service'
import { balanceOf, recordMovement } from '../apps/api/src/services/stock.service'
import { approveReallocation, raiseReallocation } from '../apps/api/src/services/brandStock.service'
import { stockReconciliation } from '../apps/api/src/reports/definitions/stock-reconciliation'
import { wipReconciliation } from '../apps/api/src/reports/definitions/wip-reconciliation'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 600)}` : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const stamp = Date.now().toString(36).slice(-5).toUpperCase()
const r2 = (n: number) => Math.round(n * 100) / 100
const near = (a: number, b: number, by = 0.01) => Math.abs(a - b) <= by

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** Every balance of these items, store by store: quantity and value, and whether any is valued at nothing held. */
async function balancesOfItems(tx: Tx, itemIds: string[]) {
  return tx.$queryRaw<Array<{ itemId: string; warehouseId: string; sizeId: string | null; grade: string; qty: number; value: number }>>`
    SELECT "itemId", "warehouseId", "sizeId", grade,
           SUM("inQty" - "outQty")::float8 AS qty,
           SUM(("inQty" - "outQty") * COALESCE("unitRate", 0))::float8 AS value
    FROM ld_erp.stock_ledger WHERE "itemId" = ANY(${itemIds}::text[])
    GROUP BY 1, 2, 3, 4`
}
const kpi = (r: { analysis?: { kpis?: Array<{ label: string; value: unknown }> } }, label: string) =>
  Number((r.analysis?.kpis ?? []).find((k) => k.label === label)?.value ?? NaN)

async function main() {
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== 'lderp_demo') {
    console.error('Refusing to run: not lderp_demo.')
    process.exitCode = 2
    return
  }
  const cust = await prisma.customer.findFirst({ where: { isActive: true, isBlacklisted: false, OR: [{ shippingStateCode: { not: null } }, { billingStateCode: { not: null } }] }, select: { id: true } })
  const brand = await prisma.brand.findFirst({ where: { isActive: true, isDefault: true } })
  const fabricTemplate = await prisma.item.findUnique({ where: { code: 'FAB-COT-001' } })
  const fgTemplate = await prisma.item.findUnique({ where: { code: 'FG-SHRT-001' } })
  const user = await prisma.user.findFirst({ where: { role: { name: { in: ['Super Admin', 'Admin'] } } }, select: { id: true } })
  const style = await prisma.style.findUnique({ where: { code: 'LD-SH-2601' }, include: { sizeGroup: { include: { sizes: true } } } })
  const ops = new Map((await prisma.operation.findMany({ select: { id: true, code: true, kind: true, departmentId: true } })).map((o) => [o.code, o]))
  const company = await prisma.warehouse.findFirst({ select: { companyId: true } })
  const cuttingDept = await prisma.department.findFirst({ where: { name: 'Cutting' }, select: { id: true } })
  if (!cust || !brand || !fabricTemplate || !fgTemplate || !user || !style?.sizeGroup || !company || !cuttingDept || !ops.get('OP-CUT') || !ops.get('OP-STI') || !ops.get('OP-PKG')) {
    throw new Error('demo masters missing')
  }
  const admin = { id: user.id, role: 'Super Admin', superAdmin: true, permissions: [] } as never
  // Someone else, to approve an earmark (multi-brand phase 5, decision 8).
  const other = await prisma.user.findFirstOrThrow({ where: { id: { not: user.id } }, select: { id: true } })
  const [S1, S2] = [...style.sizeGroup.sizes].sort((a, b) => a.sequence - b.sequence)
  const op = (code: string) => ops.get(code)!
  const seriesBefore = JSON.stringify(await prisma.numberSeries.findMany({ select: { docType: true, lastNumber: true }, orderBy: { docType: 'asc' } }))
  const reconBefore = await stockReconciliation.run({ tx: prisma as never, params: {}, rowCap: 5000 } as never)
  const findingsBefore = kpi(reconBefore as never, 'Findings')

  try {
    await prisma.$transaction(
      async (tx) => {
        // ── Masters for this run ──
        const store = (name: string, kind: 'GENERAL' | 'FINISHED_GOODS') =>
          tx.warehouse.create({ data: { name, code: `ZZMR-${kind.slice(0, 2)}-${stamp}`, kind, companyId: company.companyId }, select: { id: true, name: true } })
        const FAB = await store(`ZZTEST MR Fabric ${stamp}`, 'GENERAL')
        const FGS = await store(`ZZTEST MR Finished ${stamp}`, 'FINISHED_GOODS')
        const fabric = await tx.item.create({ data: { code: `ZZMRF${stamp}`, name: `ZZTEST MR fabric ${stamp}`, type: 'RAW_MATERIAL', categoryId: fabricTemplate.categoryId, uomId: fabricTemplate.uomId }, select: { id: true } })
        const color = `ZZ MR ${stamp}`
        await tx.style.update({ where: { id: style.id }, data: { colors: { push: color } } })
        const taxRateId = fgTemplate.taxRateId ?? (await tx.taxRate.findFirstOrThrow({ where: { rate: 5 } })).id
        const fg = await tx.item.create({
          data: { code: `ZZMRG${stamp}`, name: `ZZTEST MR shirt ${stamp}`, type: 'FINISHED_GOOD', categoryId: fgTemplate.categoryId, uomId: fgTemplate.uomId, styleId: style.id, color, standardRate: 250, hsnCode: fgTemplate.hsnCode ?? '6205', taxRateId },
          select: { id: true },
        })
        // What a finished piece goes into stock at, by the rule finished goods follow.
        const fgRate = (await fgRates(tx, [{ id: fg.id, styleId: style.id, color, standardRate: 250 as never }])).get(fg.id)!
        const R = fgRate.rate
        const panelItem = await tx.item.create({ data: { code: `ZZMRP${stamp}`, name: `ZZTEST MR cut panels ${stamp}`, type: 'SEMI_FINISHED', categoryId: fgTemplate.categoryId, uomId: fgTemplate.uomId }, select: { id: true } })
        const ours = [fabric.id, fg.id, panelItem.id]

        // ── 1. Fabric received at two rates: 300 m at ₹120, 100 m at ₹135 ──
        const ref = { referenceType: 'ZZTEST_PURCHASE', referenceId: `zzmr-${stamp}` }
        await recordMovement(tx, { itemId: fabric.id, warehouseId: FAB.id, transactionType: 'PURCHASE', direction: 'IN', qty: 300, unitRate: 120, ...ref })
        await recordMovement(tx, { itemId: fabric.id, warehouseId: FAB.id, transactionType: 'PURCHASE', direction: 'IN', qty: 100, unitRate: 135, ...ref })
        let fab = await balanceOf(tx, { itemId: fabric.id, warehouseId: FAB.id })
        check('fabric in: 400 m worth ₹49,500, a moving average of ₹123.75', fab.qty === 400 && fab.value === 49500 && fab.avgRate === 123.75, fab)

        // ── 2. The order, two MOs: one with a route (200 pieces), one without (40) ──
        const { header, lines } = await prepareOrder(
          tx,
          createSalesOrderSchema.parse({ customerId: cust.id, brandId: brand.id, customerPORef: `ZZMR-${stamp}`, lines: [{ itemId: fg.id, color, totalQty: 240, unitPrice: 420, sizes: [{ sizeId: S1.id, qty: 120 }, { sizeId: S2.id, qty: 120 }] }] }),
        )
        const so = await tx.salesOrder.create({ data: { ...header, soNumber: `ZZ-MRSO-${stamp}`, status: 'CONFIRMED', createdById: user.id, lines: { create: lines } }, include: { lines: true } })
        const routing = await tx.routing.create({
          data: {
            code: `ZZ-MRRT-${stamp}`,
            name: 'ZZTEST reconciliation route',
            styleId: style.id,
            steps: {
              create: (['OP-CUT', 'OP-STI', 'OP-PKG'] as const).map((c, i) => ({ sequence: i + 1, operationId: op(c).id, departmentId: op(c).departmentId, execution: 'IN_HOUSE' as const, skip: 'WITH_APPROVAL' as const, isQcStep: false })),
            },
          },
        })
        const mo = await createMo(tx, createMoSchema.parse({ soId: so.id, release: true, lines: [{ soLineId: so.lines[0].id, sizes: [{ sizeId: S1.id, qty: 100 }, { sizeId: S2.id, qty: 100 }] }] }), user.id)
        await applyRouting(tx, mo.id, routing.id)
        const [CUT, STI, PKG] = (await tx.mOStep.findMany({ where: { moId: mo.id }, orderBy: { sequence: 'asc' } })).map((s) => s.id)
        const mo2 = await createMo(tx, createMoSchema.parse({ soId: so.id, release: true, lines: [{ soLineId: so.lines[0].id, sizes: [{ sizeId: S1.id, qty: 20 }, { sizeId: S2.id, qty: 20 }] }] }), user.id)
        check('two orders made from one sales order line: 200 routed, 40 without a route', mo.status === 'RELEASED' && mo2.status === 'RELEASED', [mo.status, mo2.status])

        // ── 3. Materials issued: 280 m to the routed order, 60 m to the other, each at the average ──
        const issue = async (moId: string, qty: number, no: string) => {
          // Multi-brand phase 5: this fabric is not in the order's plan (it has no BOM), so central
          // stock does not move to the order's brand by itself (decision 7): it is earmarked for
          // the brand first, raised by one person and approved by another, then issued from it.
          const { brandId } = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: moId }, select: { brandId: true } })
          const ear = await raiseReallocation(tx, { kind: 'EARMARK', warehouseId: FAB.id, fromBrandId: null, toBrandId: brandId, moId, reason: `ZZTEST fabric for order ${no}`, lines: [{ itemId: fabric.id, qty }] }, user.id)
          await approveReallocation(tx, ear.id, { id: other.id, admin: false })
          const mr = await tx.materialRequisition.create({
            data: { mrNumber: `ZZ-MRMR-${no}-${stamp}`, moId, soId: so.id, departmentId: cuttingDept.id, status: 'APPROVED', raisedById: null, lines: { create: [{ itemId: fabric.id, requestedQty: qty, warehouseId: FAB.id }] } },
            include: { lines: true },
          })
          await issueRequisition(tx, mr.id, { lines: [{ lineId: mr.lines[0].id, issueQty: qty, warehouseId: FAB.id }] }, admin)
          const rows = await tx.stockLedger.findMany({ where: { referenceType: 'MATERIAL_REQUISITION', referenceId: mr.id }, select: { outQty: true, unitRate: true } })
          return { value: rows.reduce((s, r) => s + Number(r.outQty) * Number(r.unitRate ?? 0), 0), mr }
        }
        const { value: issued1 } = await issue(mo.id, 280, '1')
        const { value: issued2, mr: mr2 } = await issue(mo2.id, 60, '2')
        fab = await balanceOf(tx, { itemId: fabric.id, warehouseId: FAB.id })
        check('issued at the moving average: 280 m = ₹34,650 and 60 m = ₹7,425', near(issued1, 34650) && near(issued2, 7425), [issued1, issued2])
        check('the store keeps 60 m worth exactly ₹7,425, at the same average', fab.qty === 60 && fab.value === 7425 && fab.avgRate === 123.75, fab)

        // ── 4. Routed order: a contractor cuts 198 of 200 into bundles ──
        const card = await tx.jobCard.findFirstOrThrow({ where: { moId: mo.id } })
        const given = await issueToCutter(tx, mo.id, cutterIssueSchema.parse({ moLineId: card.moLineId, cutterName: 'ZZTEST Ramesh', fabricItemId: fabric.id, fabricGiven: 280, planned: [{ sizeId: S1.id, qty: 100 }, { sizeId: S2.id, qty: 100 }] }), user.id)
        await createCutting(tx, mo.id, cuttingSchema.parse({ fabricItemId: fabric.id, fabricUsed: 270, wastage: 10, bundleSize: 25, sizes: [{ sizeId: S1.id, qty: 100 }, { sizeId: S2.id, qty: 98 }], clientKey: `zzmr-cut-${stamp}` }), user.id, { issueId: given.id })
        const bundles = await tx.productionBundle.findMany({ where: { moId: mo.id }, orderBy: { bundleNo: 'asc' } })
        const wipRow = async () => {
          const r = (await wipReconciliation.run({ tx, params: { which: 'all' }, rowCap: 5000 } as never)) as { rows: Array<Record<string, unknown>> }
          return r.rows.find((x) => x.mo === mo.moNumber) as Record<string, number | string> | undefined
        }
        const addsUp = (w?: Record<string, number | string>) => !!w && Number(w.cut) === Number(w.onFloor) + Number(w.waiting) + Number(w.scrapped) + Number(w.packed)
        let w = await wipRow()
        check('cut 198: on the floor all of it, and the report adds up', bundles.reduce((s, b) => s + b.qty, 0) === 198 && Number(w?.cut) === 198 && addsUp(w), w)
        check('the report values what was issued to the order: ₹34,650', near(Number(w?.issuedValue), 34650), w?.issuedValue)

        // ── 5. Cutting → stitching, 6 damaged there (waiting a decision) → packing ──
        const { transfer: t1 } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: CUT, lines: bundles.map((b) => ({ bundleId: b.id, qty: b.qty })), issuedBy: 'ZZTEST Ramesh' }), user.id)
        await receive(tx, t1.id, receiveSchema.parse({ lines: (await tx.processTransferLine.findMany({ where: { transferId: t1.id } })).map((l) => ({ lineId: l.id, qty: l.dispatchedQty })), receivedBy: 'ZZTEST Mahesh' }), user.id)
        await recordWork(tx, mo.id, STI, workSchema.parse({ lines: [{ bundleId: bundles[0].id, damaged: 6 }], reason: 'ZZTEST needle holes', personName: 'Line 3' }), user.id)
        w = await wipRow()
        check('6 damaged at stitching wait a decision; still 198 = floor + waiting + scrapped + packed', Number(w?.waiting) === 6 && addsUp(w), w)
        const inHand = (await balancesOf(tx, mo.id)).filter((r) => r.stepId === STI && r.bucket === 'WIP' && !r.vendorId && r.qty > 0)
        const { transfer: t2 } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: STI, lines: inHand.map((r) => ({ bundleId: r.bundleId, qty: r.qty })) }), user.id)
        await receive(tx, t2.id, receiveSchema.parse({ lines: (await tx.processTransferLine.findMany({ where: { transferId: t2.id } })).map((l) => ({ lineId: l.id, qty: l.dispatchedQty })) }), user.id)
        const atPacking = (await balancesOf(tx, mo.id)).filter((r) => r.stepId === PKG && r.bucket === 'WIP' && r.qty > 0)
        const sizeOf = new Map(bundles.map((b) => [b.id, b.sizeId]))
        const s1 = atPacking.filter((r) => sizeOf.get(r.bundleId) === S1.id).reduce((s, r) => s + r.qty, 0)
        const s2 = atPacking.filter((r) => sizeOf.get(r.bundleId) === S2.id).reduce((s, r) => s + r.qty, 0)
        check('192 reached packing (198 cut − 6 damaged)', s1 + s2 === 192, [s1, s2])

        // ── 6. Finished goods into stock at their cost: the style's BOM costing, else ₹250 standard ──
        await createFgReceipt(tx, fgSchema.parse({ warehouseId: FGS.id, moId: mo.id, lines: [{ itemId: fg.id, sizeId: S1.id, qty: s1 }, { itemId: fg.id, sizeId: S2.id, qty: s2 }] }), user.id)
        const fgVal = async () => {
          const rows = (await balancesOfItems(tx, [fg.id])).filter((r) => r.warehouseId === FGS.id)
          return { qty: rows.reduce((s, r) => s + Number(r.qty), 0), value: r2(rows.reduce((s, r) => s + Number(r.value), 0)) }
        }
        let fgNow = await fgVal()
        check(`192 finished pieces in stock at ₹${R} (${fgRate.source === 'BOM' ? `BOM ${fgRate.bomVersion}` : 'standard rate'}): ₹${r2(192 * R)}`, fgNow.qty === 192 && near(fgNow.value, r2(192 * R)), [fgNow, R])
        w = await wipRow()
        check('the report: 192 packed and received, none packed but not received; their value received', Number(w?.packed) === 192 && Number(w?.received) === 192 && Number(w?.packedNotReceived) === 0 && near(Number(w?.receivedValue), r2(192 * R)) && addsUp(w), w)

        // ── 7. Dispatched on a challan: 150 pieces at the finished-goods average ──
        const order = await loadOpenOrder(tx, so.id)
        const dcInput = { soId: so.id, warehouseId: FGS.id, lines: [{ soLineId: so.lines[0].id, sizes: [{ sizeId: S1.id, qty: 80 }, { sizeId: S2.id, qty: 70 }] }] }
        const dc = await writeChallan(tx, order, dcInput as never, null, user.id)
        await dispatchChallan(tx, dc.id, user.id)
        fgNow = await fgVal()
        check(`150 dispatched at the finished-goods average ₹${R}: 42 pieces worth ₹${r2(42 * R)} left`, fgNow.qty === 42 && near(fgNow.value, r2(42 * R)), fgNow)
        await cancelChallan(tx, dc.id, user.id, 'ZZTEST wrong vehicle')
        fgNow = await fgVal()
        check('the challan cancelled: all 192 back, at exactly the value they left at', fgNow.qty === 192 && near(fgNow.value, r2(192 * R)), fgNow)
        const dc2 = await writeChallan(tx, await loadOpenOrder(tx, so.id), dcInput as never, null, user.id)
        await dispatchChallan(tx, dc2.id, user.id)
        fgNow = await fgVal()
        check('dispatched again: 42 left at the same value as the first time', fgNow.qty === 42 && near(fgNow.value, r2(42 * R)), fgNow)

        // ── 8. The order without a route: 40 panels cut from 50 m go into stock at the fabric's value ──
        await createCutting(tx, mo2.id, cuttingSchema.parse({ fabricItemId: fabric.id, fabricUsed: 50, wastage: 4, sizes: [{ sizeId: S1.id, qty: 20 }, { sizeId: S2.id, qty: 20 }], panelItemId: panelItem.id, panelWarehouseId: FAB.id, clientKey: `zzmr-cut2-${stamp}` }), user.id)
        const panels = (await balancesOfItems(tx, [panelItem.id])).reduce((s, r) => ({ qty: s.qty + Number(r.qty), value: s.value + Number(r.value) }), { qty: 0, value: 0 })
        // 50 m at ₹123.75 = ₹6,187.50 spread over 40 panels (₹154.69 each, to the paisa).
        check('40 cut panels in stock carry the 50 m of fabric in them: ₹6,187.50, to within the paisa per panel', panels.qty === 40 && near(panels.value, 6187.5, 40 * 0.005 + 0.001), panels)
        // The 6 m left over goes back to the store, at the rate it went out at.
        await returnFromFloor(tx, mr2.id, { reason: 'ZZTEST leftover after cutting', lines: [{ lineId: mr2.lines[0].id, qty: 6, warehouseId: FAB.id }] }, user.id)
        fab = await balanceOf(tx, { itemId: fabric.id, warehouseId: FAB.id })
        check('the 6 m left over comes back at ₹123.75: the store holds 66 m worth ₹8,167.50, its average unchanged', fab.qty === 66 && fab.value === 8167.5 && fab.avgRate === 123.75, fab)

        // ── 9. Every balance of these items: value only where there is stock, never below nothing ──
        const all = await balancesOfItems(tx, ours)
        const odd = all.filter((r) => Number(r.qty) < -0.0005 || (Math.abs(Number(r.qty)) <= 0.0005 && Math.abs(Number(r.value)) > 0.01) || Number(r.value) < -0.01)
        check('no balance below nothing, and none valued with nothing in it', odd.length === 0, odd)

        // ── 10. Stock Reconciliation, inside the same transaction ──
        const recon = (await stockReconciliation.run({ tx, params: {}, rowCap: 5000 } as never)) as { rows: Array<Record<string, unknown>>; analysis?: { kpis?: Array<{ label: string; value: unknown }> } }
        const mine = recon.rows.filter((r) => [`ZZTEST MR fabric ${stamp}`, `ZZTEST MR shirt ${stamp}`, `ZZTEST MR cut panels ${stamp}`].includes(String(r.item)))
        check('Stock Reconciliation: nothing found against these items', mine.length === 0, mine)
        check('…and nothing new anywhere', kpi(recon as never, 'Findings') <= Math.max(0, findingsBefore), [kpi(recon as never, 'Findings'), findingsBefore])
        check('…and the stock value still agrees with the books', Math.abs(kpi(recon as never, 'Not explained')) < 1, kpi(recon as never, 'Not explained'))

        throw ROLLBACK
      },
      { timeout: 900_000, maxWait: 30_000 },
    )
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  const seriesAfter = JSON.stringify(await prisma.numberSeries.findMany({ select: { docType: true, lastNumber: true }, orderBy: { docType: 'asc' } }))
  check('nothing kept: no number series touched', seriesAfter === seriesBefore)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
