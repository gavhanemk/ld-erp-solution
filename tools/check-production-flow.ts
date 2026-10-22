// The job-card flow end to end, on the live shared database inside one
// transaction that always throws (nothing is kept): an order released without
// a routing, job cards made, cutting refused before materials are issued,
// stages loaded, sizes issued to cutting contractors and received back cut,
// process transfers with a short count and its settlement, a working step
// sending on straight from in hand, a check with rework, an outside unit,
// packing into finished goods, and the sheets' figures per job card and size.
//
// Rolled back: everything happens inside one transaction that always throws,
// so nothing is kept and no number series moves — safe on the shared
// database. It needs the demo masters (FAB-COT-001, FG-SHRT-001, style
// LD-SH-2601 with a size run, the OP-* processes, a washing and an embroidery
// job-work unit). Run it from apps/api, so the database settings load:
//
//   cd apps/api
//   npx tsx ../../tools/check-production-flow.ts
import { prisma } from '../packages/database/src/index'
import { createSalesOrderSchema, prepareOrder } from '../apps/api/src/routes/sales.routes'
import { createMo, createMoSchema, releaseMo } from '../apps/api/src/routes/production.routes'
import { createFgReceipt, createSchema as fgSchema } from '../apps/api/src/routes/finishedGoods.routes'
import { cancelCutting, createCutting, cuttingSchema, cutterIssueSchema, issueToCutter } from '../apps/api/src/services/cutting.service'
import {
  cancelTransfer,
  closeJobWorkOrder,
  decide,
  decideSchema,
  dispatch,
  dispatchSchema,
  receive,
  receiveSchema,
  recordWork,
  reworkDone,
  reworkDoneSchema,
  settleSchema,
  settleShort,
  undoEvent,
  vendorReturn,
  vendorReturnSchema,
  workSchema,
} from '../apps/api/src/services/floor.service'
import { applyRouting } from '../apps/api/src/services/route.service'
import { jobCardDetail, listJobCards, stageSheets, updateJobCard, jobCardSchema } from '../apps/api/src/services/jobCard.service'
import { balancesOf } from '../apps/api/src/services/wip.service'
import { balanceOf } from '../apps/api/src/services/stock.service'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const stamp = Date.now().toString(36)

async function main() {
  const cust = await prisma.customer.findFirst({ where: { isActive: true, isBlacklisted: false, OR: [{ shippingStateCode: { not: null } }, { billingStateCode: { not: null } }] }, select: { id: true } })
  const brand = await prisma.brand.findFirst({ where: { isActive: true } })
  const fabric = await prisma.item.findUnique({ where: { code: 'FAB-COT-001' } })
  const fgTemplate = await prisma.item.findUnique({ where: { code: 'FG-SHRT-001' } })
  const store = await prisma.warehouse.findFirst({ where: { isActive: true }, select: { id: true } })
  const user = await prisma.user.findFirst({ select: { id: true } })
  const style = await prisma.style.findUnique({ where: { code: 'LD-SH-2601' }, include: { sizeGroup: { include: { sizes: true } } } })
  const ops = new Map((await prisma.operation.findMany({ select: { id: true, code: true, kind: true, departmentId: true } })).map((o) => [o.code, o]))
  const units = await prisma.workstation.findMany({ where: { type: 'JOB_WORK', supplierId: { not: null } }, select: { supplierId: true, department: { select: { name: true } } } })
  const washer = units.find((u) => u.department.name === 'Washing')?.supplierId
  if (!cust || !brand || !fabric || !fgTemplate || !store || !user || !style?.sizeGroup || !washer) throw new Error('test data missing')
  const [S1, S2] = [...style.sizeGroup.sizes].sort((a, b) => a.sequence - b.sequence)
  const op = (code: string) => ops.get(code)!
  const seriesBefore = JSON.stringify(await prisma.numberSeries.findMany({ select: { docType: true, lastNumber: true }, orderBy: { docType: 'asc' } }))

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
        const color = 'ZZ Test Grey'
        await tx.style.update({ where: { id: style.id }, data: { category: 'Shirt', colors: { push: color } } })
        const taxRateId = fgTemplate.taxRateId ?? (await tx.taxRate.findFirstOrThrow({ where: { rate: 5 } })).id
        const fg = await tx.item.create({
          data: { code: `ZZ-FG-${stamp}`, name: 'Test shirt', type: 'FINISHED_GOOD', categoryId: fgTemplate.categoryId, uomId: fgTemplate.uomId, styleId: style.id, color, standardRate: 250, hsnCode: fgTemplate.hsnCode ?? '6205', taxRateId },
        })
        const { header, lines } = await prepareOrder(
          tx,
          createSalesOrderSchema.parse({ customerId: cust.id, brandId: brand.id, customerPORef: 'LDCM-06', lines: [{ itemId: fg.id, color, totalQty: 400, unitPrice: 300, fabric: 'Poplin print PS-426A', printName: 'DCSHRFS01001099-02', sizes: [{ sizeId: S1.id, qty: 200 }, { sizeId: S2.id, qty: 200 }] }] }),
        )
        const so = await tx.salesOrder.create({ data: { ...header, soNumber: `ZZ-SO-${stamp}`, status: 'CONFIRMED', createdById: user.id, lines: { create: lines } }, include: { lines: true } })
        const routing = await tx.routing.create({
          data: {
            code: `ZZ-RT-${stamp}`,
            name: 'Test route',
            styleId: style.id,
            steps: {
              create: (
                [
                  ['OP-CUT', 'IN_HOUSE'],
                  ['OP-STI', 'IN_HOUSE'],
                  ['OP-WSH', 'OUTSOURCED'],
                  ['OP-LINEQC', 'IN_HOUSE'],
                  ['OP-PKG', 'IN_HOUSE'],
                ] as const
              ).map(([c, ex], i) => ({ sequence: i + 1, operationId: op(c).id, departmentId: op(c).departmentId, execution: ex, skip: 'WITH_APPROVAL' as const, isQcStep: op(c).kind === 'QC' })),
            },
          },
        })

        // ── MO → released without a routing → job cards ──
        const mo = await createMo(tx, createMoSchema.parse({ soId: so.id, release: true, lines: [{ soLineId: so.lines[0].id, sizes: [{ sizeId: S1.id, qty: 200 }, { sizeId: S2.id, qty: 200 }] }] }), user.id)
        check('released without a routing', mo.status === 'RELEASED' && !mo.routingId)
        const card = await tx.jobCard.findFirstOrThrow({ where: { moId: mo.id } })
        check('a job card per colour, numbered from the order, header from the sales order', card.jobCardNumber === `${mo.moNumber}-JC1` && card.orderNo === 'LDCM-06' && card.designNo === 'DCSHRFS01001099-02' && card.fabricQuality === 'Poplin print PS-426A', JSON.stringify({ n: card.jobCardNumber, o: card.orderNo, d: card.designNo, f: card.fabricQuality }))
        await updateJobCard(tx, card.id, jobCardSchema.parse({ orderNo: 'LDCM-06', projectId: 'DC-46', designNo: 'DCSHRFS01001099-02', fabricQuality: 'Poplin print PS-426A', meters: 560, average: 1.4, ratio: 'S2 M2', lotNo: 'LOT-7' }))

        // ── No cutting before stages and materials ──
        await refuses('no cutting sheet before the stages are loaded', () => issueToCutter(tx, mo.id, cutterIssueSchema.parse({ moLineId: card.moLineId, cutterName: 'Ramesh', planned: [{ sizeId: S1.id, qty: 10 }] }), user.id), 'NO_ROUTE')
        await applyRouting(tx, mo.id, routing.id)
        const steps = await tx.mOStep.findMany({ where: { moId: mo.id }, orderBy: { sequence: 'asc' } })
        const [CUT, STI, WSH, QC, PKG] = steps.map((s) => s.id)
        await refuses('no issue to a cutting contractor before the materials are issued', () => issueToCutter(tx, mo.id, cutterIssueSchema.parse({ moLineId: card.moLineId, cutterName: 'Ramesh', planned: [{ sizeId: S1.id, qty: 10 }] }), user.id), 'MATERIALS_NOT_ISSUED')
        const dept = await tx.department.findFirstOrThrow({ where: { name: 'Cutting' } })
        await tx.materialRequisition.create({
          data: { mrNumber: `ZZ-MR-${stamp}`, moId: mo.id, departmentId: dept.id, status: 'APPROVED', issuedAt: new Date(), lines: { create: [{ itemId: fabric.id, requestedQty: 600, issuedQty: 600, warehouseId: store.id }] } },
        })

        // ── Cutting sheet: sizes issued to two contractors, received back cut ──
        const i1 = await issueToCutter(tx, mo.id, cutterIssueSchema.parse({ moLineId: card.moLineId, cutterName: 'Ramesh', lotNo: 'LOT-7', ratio: 'S2 M2', fabricItemId: fabric.id, fabricGiven: 300, planned: [{ sizeId: S1.id, qty: 120 }, { sizeId: S2.id, qty: 100 }] }), user.id)
        check('issued to a contractor: with them, nothing cut yet', i1.status === 'IN_PROGRESS' && i1.actualPieces === 0 && i1.plannedPieces === 220 && /^CUT\/.+\/\d{2}$/.test(i1.cutOrderNumber), i1.cutOrderNumber)
        await refuses('not more than is left, counting what contractors have', () => issueToCutter(tx, mo.id, cutterIssueSchema.parse({ moLineId: card.moLineId, cutterName: 'Suresh', planned: [{ sizeId: S1.id, qty: 81 }] }), user.id), 'MORE_THAN_PLANNED')
        const i2 = await issueToCutter(tx, mo.id, cutterIssueSchema.parse({ moLineId: card.moLineId, cutterName: 'Suresh', fabricItemId: fabric.id, planned: [{ sizeId: S1.id, qty: 80 }, { sizeId: S2.id, qty: 100 }] }), user.id)
        let figs = (await jobCardDetail(tx, card.id))
        check('the order is not cut until it comes back', figs.steps.find((s) => s.id === CUT)!.figures!.completed === 0)

        const r1 = await createCutting(tx, mo.id, cuttingSchema.parse({ fabricItemId: fabric.id, fabricUsed: 290, wastage: 8, bundleSize: 25, sizes: [{ sizeId: S1.id, qty: 120 }, { sizeId: S2.id, qty: 98 }], clientKey: `k-r1-${stamp}` }), user.id, { issueId: i1.id })
        const b1 = await tx.productionBundle.findMany({ where: { cuttingOrderId: i1.id }, orderBy: { bundleNo: 'asc' } })
        check('received back: the same document completed, 218 cut, tied in 25s', r1.id === i1.id && r1.status === 'COMPLETED' && r1.actualPieces === 218 && r1.cutterName === 'Ramesh' && b1.length === 9 && b1[0].code === `${mo.moNumber}-B001`, `${r1.status} ${r1.actualPieces} ${b1.length}`)
        await refuses('an issue is received once', () => createCutting(tx, mo.id, cuttingSchema.parse({ fabricItemId: fabric.id, fabricUsed: 1, sizes: [{ sizeId: S1.id, qty: 1 }] }), user.id, { issueId: i1.id }), 'NOT_WITH_CUTTER')
        await createCutting(tx, mo.id, cuttingSchema.parse({ fabricItemId: fabric.id, fabricUsed: 250, bundleSize: 0, sizes: [{ sizeId: S1.id, qty: 80 }, { sizeId: S2.id, qty: 100 }] }), user.id, { issueId: i2.id })
        figs = await jobCardDetail(tx, card.id)
        const cutF = figs.steps.find((s) => s.id === CUT)!.figures!
        check('398 cut on the job card; 2 of size 2 never came', cutF.completed === 398 && figs.sizeFigures[S1.id].find((f) => f.stepId === CUT)!.completed === 200 && figs.sizeFigures[S2.id].find((f) => f.stepId === CUT)!.completed === 198)
        const bundles = await tx.productionBundle.findMany({ where: { moId: mo.id }, orderBy: { bundleNo: 'asc' } })

        // ── Process transfer: cutting → stitching, counted in short, settled ──
        const { transfer: t1 } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: CUT, lines: bundles.map((b) => ({ bundleId: b.id, qty: b.qty })), issuedBy: 'Ramesh' }), user.id)
        check('the transfer is filed under the job card', t1.jobCardId === card.id && /^CUT\/.+\/\d{2}$/.test(t1.transferNumber), t1.transferNumber)
        const t1Lines = await tx.processTransferLine.findMany({ where: { transferId: t1.id }, orderBy: { bundle: { bundleNo: 'asc' } } })
        await receive(tx, t1.id, receiveSchema.parse({ lines: t1Lines.map((l, i) => ({ lineId: l.id, qty: i === 0 ? l.dispatchedQty - 3 : l.dispatchedQty })), close: true, receivedBy: 'Mahesh' }), user.id)
        await settleShort(tx, t1.id, settleSchema.parse({ lines: [{ lineId: t1Lines[0].id, qty: 3, outcome: 'FOUND' }], reason: 'found under the table' }), { userId: user.id, mayApprove: false })
        figs = await jobCardDetail(tx, card.id)
        let sti = figs.steps.find((s) => s.id === STI)!.figures!
        check('stitching: 398 in hand after the short was found', sti.received === 398 && sti.inHand === 398 && sti.short === 0, JSON.stringify({ r: sti.received, h: sti.inHand }))

        // ── Stitching: 10 damaged, then sends on straight from hand ──
        await recordWork(tx, mo.id, STI, workSchema.parse({ lines: [{ bundleId: bundles[1].id, damaged: 10 }], reason: 'needle holes', personName: 'Line 3' }), user.id)
        const toWash = bundles.slice(0, 8)
        await refuses('a working step sends no more than it holds', () => dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: STI, vendorId: washer, rate: 6, lines: [{ bundleId: bundles[1].id, qty: 25 }] }), user.id), 'NOT_ENOUGH_PIECES')
        const held = await balancesOf(tx, mo.id)
        const at = (stepId: string, bundleId: string, bucket: string) => held.filter((r) => r.stepId === stepId && r.bundleId === bundleId && r.bucket === bucket && !r.vendorId).reduce((s, r) => s + r.qty, 0)
        const sentQty = toWash.reduce((s, b) => s + at(STI, b.id, 'WIP'), 0)
        const { transfer: w1 } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: STI, vendorId: washer, rate: 6, lines: toWash.map((b) => ({ bundleId: b.id, qty: at(STI, b.id, 'WIP') })) }), user.id)
        figs = await jobCardDetail(tx, card.id)
        sti = figs.steps.find((s) => s.id === STI)!.figures!
        const washF = figs.steps.find((s) => s.id === WSH)!.figures!
        check(`sent ${sentQty} straight from in hand: counted processed and sent on at stitching`, sti.completed === sentQty && sti.sentOn === sentQty && sti.damaged === 10 && sti.inHand === 398 - 10 - sentQty, JSON.stringify({ c: sti.completed, s: sti.sentOn, h: sti.inHand }))
        check(`the washer holds ${sentQty} on a job-work challan`, washF.atVendor === sentQty && !!w1.vendorId)

        // ── Back from the washer ──
        const jwo = await tx.jobWorkOrder.findFirstOrThrow({ where: { moId: mo.id, stepId: WSH } })
        const wHeld = (await balancesOf(tx, mo.id)).filter((r) => r.stepId === WSH && r.vendorId === washer && r.bucket === 'WIP')
        await vendorReturn(tx, jwo.id, vendorReturnSchema.parse({ lines: wHeld.map((r) => ({ bundleId: r.bundleId, accepted: r.qty })), theirChallanNo: 'W-2' }), user.id)
        await closeJobWorkOrder(tx, jwo.id)
        const w1After = await tx.processTransfer.findUniqueOrThrow({ where: { id: w1.id }, include: { lines: true } })
        check('the challan is marked back from the unit once everything came back', w1After.status === 'RECEIVED' && w1After.lines.every((l) => l.receivedQty === l.dispatchedQty), w1After.status)

        // ── QC: rework, then passed pieces on to packing ──
        const washed = (await balancesOf(tx, mo.id)).filter((r) => r.stepId === WSH && r.bucket === 'DONE' && !r.vendorId)
        await refuses('a check takes only passed pieces on', () => dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: QC, lines: [{ bundleId: washed[0].bundleId, qty: 1 }] }), user.id), 'NOT_ENOUGH_PIECES')
        const { transfer: q1 } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: WSH, lines: washed.map((r) => ({ bundleId: r.bundleId, qty: r.qty })) }), user.id)
        await receive(tx, q1.id, receiveSchema.parse({ lines: (await tx.processTransferLine.findMany({ where: { transferId: q1.id } })).map((l) => ({ lineId: l.id, qty: l.dispatchedQty })) }), user.id)
        const qcIn = (await balancesOf(tx, mo.id)).filter((r) => r.stepId === QC && r.bucket === 'WIP')
        await recordWork(tx, mo.id, QC, workSchema.parse({ lines: [{ bundleId: qcIn[0].bundleId, done: qcIn[0].qty - 5, rework: 5 }, ...qcIn.slice(1).map((r) => ({ bundleId: r.bundleId, done: r.qty }))], reworkStepId: STI }), user.id)
        await reworkDone(tx, mo.id, QC, reworkDoneSchema.parse({ lines: [{ bundleId: qcIn[0].bundleId, qty: 5, reworkStepId: STI }] }), user.id)
        await recordWork(tx, mo.id, QC, workSchema.parse({ lines: [{ bundleId: qcIn[0].bundleId, done: 5 }] }), user.id)
        figs = await jobCardDetail(tx, card.id)
        const qcF = figs.steps.find((s) => s.id === QC)!.figures!
        check(`QC passed all ${sentQty}, the 5 reworked not counted twice`, qcF.completed === sentQty && qcF.inRework === 0, String(qcF.completed))

        const passed = (await balancesOf(tx, mo.id)).filter((r) => r.stepId === QC && r.bucket === 'DONE')
        const { transfer: p1 } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: QC, lines: passed.map((r) => ({ bundleId: r.bundleId, qty: r.qty })) }), user.id)
        await receive(tx, p1.id, receiveSchema.parse({ lines: (await tx.processTransferLine.findMany({ where: { transferId: p1.id } })).map((l) => ({ lineId: l.id, qty: l.dispatchedQty })) }), user.id)

        // ── Packing is the last step: finished goods straight from in hand ──
        const s1Pack = (await balancesOf(tx, mo.id)).filter((r) => r.stepId === PKG && r.bucket === 'WIP')
        const bundleSize = new Map(bundles.map((b) => [b.id, b.sizeId]))
        const s1Qty = s1Pack.filter((r) => bundleSize.get(r.bundleId) === S1.id).reduce((s, r) => s + r.qty, 0)
        await refuses('not more into stock than has reached packing', () => createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: [{ itemId: fg.id, sizeId: S1.id, qty: s1Qty + 1 }] }), user.id), 'NOT_FINISHED')
        const stock0 = (await balanceOf(tx, { itemId: fg.id, warehouseId: store.id, sizeId: S1.id })).qty
        await createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: [{ itemId: fg.id, sizeId: S1.id, qty: s1Qty }] }), user.id)
        check(`${s1Qty} of size 1 into stock from packing in hand`, (await balanceOf(tx, { itemId: fg.id, warehouseId: store.id, sizeId: S1.id })).qty === stock0 + s1Qty)
        figs = await jobCardDetail(tx, card.id)
        const pk = figs.steps.find((s) => s.id === PKG)!.figures!
        check('packing counts them done and packed', pk.packed === s1Qty && pk.completed === s1Qty, JSON.stringify({ p: pk.packed, c: pk.completed }))

        // ── The sheets ──
        const rows = (await stageSheets(tx, { stage: 'STITCHING', show: 'all', page: 1, limit: 200 })).data.filter((r) => r.card.id === card.id)
        check('the stitching sheets list the job card with its figures', rows.length === 1 && rows[0].figures.received === 398 && rows[0].next?.name === steps[2].name)
        const cutRows = (await stageSheets(tx, { stage: 'CUTTING', show: 'all', page: 1, limit: 200 })).data.filter((r) => r.card.id === card.id)
        check('the cutting sheets list it too', cutRows.length === 1 && cutRows[0].figures.completed === 398)
        const list = (await listJobCards(tx, { show: 'all', moId: mo.id, page: 1, limit: 10 })).data
        check('the job card list shows where it is', list.length === 1 && list[0].cut === 398 && list[0].state === 'IN_PROGRESS' && list[0].atStages.length > 0, JSON.stringify(list[0]?.atStages))
        check('its log has the entries for the sheets', figs.log.length > 20 && figs.log.every((e) => !!e.eventId))

        // ── Undo and cancel ──
        const dmg = await tx.wipEvent.findFirstOrThrow({ where: { moId: mo.id, stepId: STI, type: 'PROCESS' } })
        await undoEvent(tx, dmg.id, 'counted wrong', user.id)
        check('undone: the 10 damaged are back in hand at stitching', (await jobCardDetail(tx, card.id)).steps.find((s) => s.id === STI)!.figures!.inHand === 398 - sentQty)
        const left = (await balancesOf(tx, mo.id)).filter((r) => r.stepId === STI && r.bucket === 'WIP')
        const { transfer: x1 } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: STI, vendorId: washer, lines: [{ bundleId: left[0].bundleId, qty: 1 }] }), user.id)
        check('a second unit order reuses none of the closed one', x1.jobWorkOrderId !== jwo.id)
        await refuses('a challan back from the unit cannot be cancelled', () => cancelTransfer(tx, w1.id, 'mistake', user.id), 'ALREADY_RECEIVED')
        await refuses('a batch whose bundles moved on cannot be cancelled', () => cancelCutting(tx, i1.id, 'mistake', user.id), 'MOVED_ON')

        // Every bundle's pieces add up to what was cut into it.
        const sums = await tx.wipEntry.groupBy({ by: ['bundleId'], where: { moId: mo.id }, _sum: { qty: true } })
        const qtyOf = new Map(bundles.map((b) => [b.id, b.qty]))
        check('no piece appears or vanishes', sums.every((s) => (s._sum.qty ?? 0) === qtyOf.get(s.bundleId)))

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
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
