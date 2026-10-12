// The production flow end to end, on the live shared database inside one
// transaction that always throws (nothing is kept): routing master rules and
// suggestions, an order's own route, cutting in batches with bundles,
// transfer cards with short/found/lost/excess, work at each step, QC with
// rework/B-grade/write-off, skipping, route changes, undo, hold, packing into
// finished goods, and a route with two outside steps on job work orders.
//
// Rolled back: everything happens inside one transaction that always throws,
// so nothing is kept and no number series moves — safe on the shared
// database. It needs the demo masters (FAB-COT-001, FG-SHRT-001, style
// LD-SH-2601 with a size run, the OP-* processes, a washing and an embroidery
// job-work unit). Run it from apps/api, so the database settings load:
//
//   cd apps/api
//   npx tsx ../../tools/check-production-floor.ts
import { prisma } from '../packages/database/src/index'
import { createSalesOrderSchema, prepareOrder } from '../apps/api/src/routes/sales.routes'
import { createMo, createMoSchema, releaseMo, closeMo } from '../apps/api/src/routes/production.routes'
import { createFgReceipt, createSchema as fgSchema } from '../apps/api/src/routes/finishedGoods.routes'
import { cancelCutting, createCutting, cuttingSchema } from '../apps/api/src/services/cutting.service'
import {
  cancelTransfer,
  closeJobWorkOrder,
  decide,
  decideSchema,
  dispatch,
  dispatchSchema,
  holdMo,
  receive,
  receiveSchema,
  recordWork,
  resumeMo,
  reworkDone,
  reworkDoneSchema,
  sendBack,
  sendBackSchema,
  setReturnBill,
  billSchema,
  settleSchema,
  settleShort,
  stepFigures,
  undoEvent,
  unpackForReceipt,
  vendorReturn,
  vendorReturnSchema,
  workSchema,
} from '../apps/api/src/services/floor.service'
import { applyRouting, checkRouteSteps, editRoute, editRouteSchema, restoreStep, routingsFor, skipStep } from '../apps/api/src/services/route.service'
import { flowSummary } from '../apps/api/src/services/floorView.service'
import { stageSheets } from '../apps/api/src/services/jobCard.service'
import { balancesOf } from '../apps/api/src/services/wip.service'
import { balanceOf } from '../apps/api/src/services/stock.service'
import type { Prisma } from '@prisma/client'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')

const stamp = Date.now().toString(36)
type Tx = Prisma.TransactionClient

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
  const embroiderer = units.find((u) => u.department.name === 'Embroidery')?.supplierId
  const otherStyle = await prisma.style.findFirst({ where: { code: { not: 'LD-SH-2601' } }, select: { id: true } })
  if (!cust || !brand || !fabric || !fgTemplate || !store || !user || !style?.sizeGroup || !washer || !embroiderer || !otherStyle) throw new Error('test data missing')
  const [S1, S2] = [...style.sizeGroup.sizes].sort((a, b) => a.sequence - b.sequence)
  const op = (code: string) => ops.get(code)!
  const seriesBefore = JSON.stringify(await prisma.numberSeries.findMany({ select: { docType: true, lastNumber: true }, orderBy: { docType: 'asc' } }))

  try {
    await prisma.$transaction(
      async (tx) => {
        // A refused call is run inside a savepoint and rolled back to it, as its
        // own request's transaction would be: nothing it wrote before refusing stays.
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
        // ── Fixtures: a garment item of the style, and fabric issued to orders ──
        const color = 'ZZ Test Grey'
        await tx.style.update({ where: { id: style.id }, data: { category: 'Shirt', colors: { push: color } } })
        const taxRateId = fgTemplate.taxRateId ?? (await tx.taxRate.findFirstOrThrow({ where: { rate: 5 } })).id
        const fg = await tx.item.create({
          data: { code: `ZZ-FG-${stamp}`, name: 'Test shirt', type: 'FINISHED_GOOD', categoryId: fgTemplate.categoryId, uomId: fgTemplate.uomId, styleId: style.id, color, standardRate: 250, hsnCode: fgTemplate.hsnCode ?? '6205', taxRateId },
        })
        const issueFabric = async (moId: string, qty: number) => {
          const dept = await tx.department.findFirstOrThrow({ where: { name: 'Cutting' } })
          await tx.materialRequisition.create({
            data: { mrNumber: `ZZ-MR-${stamp}-${Math.random().toString(36).slice(2, 7)}`, moId, departmentId: dept.id, status: 'APPROVED', lines: { create: [{ itemId: fabric.id, requestedQty: qty, issuedQty: qty, warehouseId: store.id }] } },
          })
        }
        const mkOrder = async (perSize: number) => {
          const { header, lines } = await prepareOrder(
            tx,
            createSalesOrderSchema.parse({ customerId: cust.id, brandId: brand.id, lines: [{ itemId: fg.id, color, totalQty: perSize * 2, unitPrice: 300, sizes: [{ sizeId: S1.id, qty: perSize }, { sizeId: S2.id, qty: perSize }] }] }),
          )
          return tx.salesOrder.create({ data: { ...header, soNumber: `ZZ-SO-${Math.random().toString(36).slice(2, 9)}`, status: 'CONFIRMED', createdById: user.id, lines: { create: lines } }, include: { lines: true } })
        }
        const mkRouting = (code: string, target: { styleId?: string; category?: string }, steps: Array<[string, ('IN_HOUSE' | 'OUTSOURCED')?, ('OPTIONAL' | 'WITH_APPROVAL' | 'NEVER')?]>) =>
          tx.routing.create({
            data: {
              code,
              name: code,
              ...target,
              steps: {
                create: steps.map(([c, ex, sk], i) => ({ sequence: i + 1, operationId: op(c).id, departmentId: op(c).departmentId, execution: ex ?? 'IN_HOUSE', skip: sk ?? 'WITH_APPROVAL', isQcStep: op(c).kind === 'QC' })),
              },
            },
          })
        const stepsOf = async (moId: string) => tx.mOStep.findMany({ where: { moId }, orderBy: { sequence: 'asc' } })
        const figures = async (moId: string) => {
          const mo = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: moId }, select: { totalPlannedQty: true, steps: true } })
          const f = await stepFigures(tx, moId, mo.steps, mo.totalPlannedQty)
          return (name: string) => f.find((x) => x.stepId === mo.steps.find((s) => s.name === name)!.id)!
        }
        const at = async (moId: string, stepId: string, bucket: string, vendorId: string | null = null) =>
          (await balancesOf(tx, moId))
            .filter((r) => r.stepId === stepId && r.bucket === bucket && (r.vendorId ?? null) === vendorId)
            .map((r) => ({ bundleId: r.bundleId, qty: r.qty, reworkStepId: r.reworkStepId }))
        const bundleNo = async (moId: string) => new Map((await tx.productionBundle.findMany({ where: { moId }, select: { id: true, bundleNo: true } })).map((b) => [b.id, b.bundleNo]))
        const sorted = async (moId: string, rows: Array<{ bundleId: string; qty: number }>) => {
          const no = await bundleNo(moId)
          return [...rows].sort((a, b) => (no.get(a.bundleId) ?? 0) - (no.get(b.bundleId) ?? 0))
        }

        // ── Routing master rules ──
        await refuses('a route starts with cutting', () => checkRouteSteps(tx, [{ operationId: op('OP-STI').id }, { operationId: op('OP-CUT').id }]), 'CUTTING_FIRST')
        await refuses('a route cuts once', () => checkRouteSteps(tx, [{ operationId: op('OP-CUT').id }, { operationId: op('OP-CUT').id }]), 'ONE_CUTTING')
        check('a route without a check is warned about', (await checkRouteSteps(tx, [{ operationId: op('OP-CUT').id }, { operationId: op('OP-STI').id }])).length === 1)

        const RA = await mkRouting(`ZZ-RA-${stamp}`, { styleId: style.id }, [['OP-CUT'], ['OP-STI'], ['OP-LINEQC', 'IN_HOUSE', 'NEVER'], ['OP-FIN', 'IN_HOUSE', 'OPTIONAL'], ['OP-FINQC', 'IN_HOUSE', 'NEVER'], ['OP-PKG']])
        const RB = await mkRouting(`ZZ-RB-${stamp}`, { category: 'Shirt' }, [['OP-CUT'], ['OP-STI'], ['OP-WSH', 'OUTSOURCED'], ['OP-EMB', 'OUTSOURCED'], ['OP-FIN'], ['OP-FINQC', 'IN_HOUSE', 'NEVER']])
        const RC = await mkRouting(`ZZ-RC-${stamp}`, {}, [['OP-CUT'], ['OP-STI'], ['OP-FINQC']])
        const RX = await mkRouting(`ZZ-RX-${stamp}`, { styleId: otherStyle.id }, [['OP-CUT'], ['OP-STI']])
        const sug = await routingsFor(tx, [style.id])
        const pos = (id: string) => sug.findIndex((r) => r.id === id)
        check("suggested: the style's own, then its category's, then any style's", pos(RA.id) >= 0 && pos(RA.id) < pos(RB.id) && pos(RB.id) < pos(RC.id), `${pos(RA.id)} ${pos(RB.id)} ${pos(RC.id)}`)
        check("another style's routing is not suggested", pos(RX.id) === -1)

        // ═══ Order A: 1,000 shirts on the style's own route ═══
        const soA = await mkOrder(500)
        const moLines = [{ soLineId: soA.lines[0].id, sizes: [{ sizeId: S1.id, qty: 500 }, { sizeId: S2.id, qty: 500 }] }]
        const draft = await createMo(tx, createMoSchema.parse({ soId: soA.id, lines: moLines }), user.id)
        await refuses("another style's routing does not fit", () => applyRouting(tx, draft.id, RX.id), 'ROUTING_DOES_NOT_FIT')
        await applyRouting(tx, draft.id, RA.id)
        const mo = await releaseMo(tx, draft.id)
        check('released: a job card for its one colour', (await tx.jobCard.count({ where: { moId: mo.id } })) === 1)
        let steps = await stepsOf(mo.id)
        const [CUT, STI, LQC, FIN, FQC, PKG] = steps.map((s) => s.id)
        check('the order has its own copy of the 6 steps, cutting first and never skipped', steps.length === 6 && steps[0].kind === 'CUTTING' && steps[0].skip === 'NEVER', steps.map((s) => s.name).join(' → '))
        await tx.routingStep.deleteMany({ where: { routingId: RA.id, sequence: 4 } })
        await tx.routing.update({ where: { id: RA.id }, data: { version: { increment: 1 } } })
        check("changing the routing later leaves the order's route alone", (await stepsOf(mo.id)).length === 6)
        await issueFabric(mo.id, 1500)

        // ── Cutting, batch 1: 200 + 200 in bundles of 25 ──
        const cutBase = { fabricItemId: fabric.id, fabricUsed: 10 }
        await refuses('more than planned needs a manager', () => createCutting(tx, mo.id, cuttingSchema.parse({ ...cutBase, sizes: [{ sizeId: S1.id, qty: 501 }], allowExcess: true }), user.id, { mayApprove: false }), 'NEEDS_APPROVAL')
        await refuses('more than planned is refused', () => createCutting(tx, mo.id, cuttingSchema.parse({ ...cutBase, sizes: [{ sizeId: S1.id, qty: 501 }] }), user.id), 'MORE_THAN_PLANNED')
        const cutKey = `k-cut-${stamp}`
        const c1 = await createCutting(
          tx,
          mo.id,
          cuttingSchema.parse({
            fabricItemId: fabric.id,
            fabricUsed: 560,
            wastage: 12,
            noOfLayers: 50,
            ratio: `${S1.code}x4 ${S2.code}x4`,
            lotNo: 'LOT-7',
            cutterName: 'Ramesh',
            bundleSize: 25,
            planned: [{ sizeId: S1.id, qty: 200 }, { sizeId: S2.id, qty: 200 }],
            sizes: [{ sizeId: S1.id, qty: 200 }, { sizeId: S2.id, qty: 200 }],
            clientKey: cutKey,
          }),
          user.id,
        )
        const b1 = await tx.productionBundle.findMany({ where: { cuttingOrderId: c1.id }, orderBy: { bundleNo: 'asc' } })
        check('400 pieces in 16 bundles of 25, numbered from the order', b1.length === 16 && b1[0].code === `${mo.moNumber}-B001` && b1.every((b) => b.qty === 25), b1[0]?.code)
        check('the first 8 bundles are the first size', b1.slice(0, 8).every((b) => b.sizeId === S1.id) && b1.slice(8).every((b) => b.sizeId === S2.id))
        check('400 done at cutting, ready to send', (await at(mo.id, CUT, 'DONE')).reduce((s, r) => s + r.qty, 0) === 400)
        const again = await createCutting(tx, mo.id, cuttingSchema.parse({ ...cutBase, fabricUsed: 560, sizes: [{ sizeId: S1.id, qty: 200 }], clientKey: cutKey }), user.id)
        check('the same save twice is stored once', again.id === c1.id && (await tx.productionBundle.count({ where: { moId: mo.id } })) === 16)
        let moNow = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id } })
        check('the order: 400 cut, in progress, started', moNow.totalCutQty === 400 && moNow.progress === 'IN_PROGRESS' && !!moNow.actualStartDate, `${moNow.totalCutQty} ${moNow.progress}`)

        // ── Transfer card 1: all 400 from cutting to stitching ──
        await refuses('only to the next step on the route', () => dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: CUT, toStepId: FIN, lines: [{ bundleId: b1[0].id, qty: 25 }] }), user.id), 'NOT_NEXT_STEP')
        await refuses('not more than a bundle has done', () => dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: CUT, lines: [{ bundleId: b1[0].id, qty: 26 }] }), user.id), 'NOT_ENOUGH_PIECES')
        const t1Key = `k-t1-${stamp}`
        const { transfer: t1 } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: CUT, lines: b1.map((b) => ({ bundleId: b.id, qty: 25 })), issuedBy: 'Suresh', clientKey: t1Key }), user.id)
        check('numbered from the order, sent to stitching', t1.transferNumber === `${mo.moNumber}-T1` && t1.toStepId === STI && t1.status === 'DISPATCHED')
        const dup = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: CUT, lines: b1.map((b) => ({ bundleId: b.id, qty: 25 })), clientKey: t1Key }), user.id)
        check('a transfer saved twice is sent once', dup.duplicate && (await tx.processTransfer.count({ where: { moId: mo.id } })) === 1)
        check('400 on the way to stitching', (await figures(mo.id))('Stitching').inTransit === 400)

        // ── Counted in: 395, the last bundle 5 short, closed ──
        const t1Lines = await tx.processTransferLine.findMany({ where: { transferId: t1.id }, include: { bundle: true }, orderBy: { bundle: { bundleNo: 'asc' } } })
        const last = t1Lines[15]
        await receive(tx, t1.id, receiveSchema.parse({ lines: t1Lines.map((l) => ({ lineId: l.id, qty: l.id === last.id ? 20 : 25 })), close: true, receivedBy: 'Mahesh' }), user.id)
        let t1Now = await tx.processTransfer.findUniqueOrThrow({ where: { id: t1.id }, include: { lines: true } })
        const l16 = t1Now.lines.find((l) => l.id === last.id)!
        check('the shortfall is held, the sender’s count kept', t1Now.status === 'DISCREPANCY' && l16.dispatchedQty === 25 && l16.receivedQty === 20 && l16.shortQty === 5)
        let F = await figures(mo.id)
        check('stitching: 395 counted in, 5 short', F('Stitching').received === 395 && F('Stitching').short === 5 && F('Stitching').inHand === 395)
        moNow = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id } })
        check('the order shows the discrepancy', moNow.progress === 'DISCREPANCY')
        await refuses('a transfer counted in is not counted again', () => receive(tx, t1.id, receiveSchema.parse({ lines: [{ lineId: last.id, qty: 1 }] }), user.id), 'ALREADY_RECEIVED')

        // ── Settled: 3 found, 2 lost (a manager writes them off) ──
        await refuses('writing pieces off needs a manager', () => settleShort(tx, t1.id, settleSchema.parse({ lines: [{ lineId: last.id, qty: 2, outcome: 'LOST' }], reason: 'not found anywhere' }), { userId: user.id, mayApprove: false }), 'NEEDS_APPROVAL')
        await refuses('cannot settle more than is short', () => settleShort(tx, t1.id, settleSchema.parse({ lines: [{ lineId: last.id, qty: 6, outcome: 'FOUND' }], reason: 'counted twice' }), { userId: user.id, mayApprove: true }), 'MORE_THAN_SHORT')
        await settleShort(
          tx,
          t1.id,
          settleSchema.parse({ lines: [{ lineId: last.id, qty: 3, outcome: 'FOUND' }, { lineId: last.id, qty: 2, outcome: 'LOST' }], reason: 'three under the table, two lost' }),
          { userId: user.id, mayApprove: true },
        )
        t1Now = await tx.processTransfer.findUniqueOrThrow({ where: { id: t1.id }, include: { lines: true } })
        F = await figures(mo.id)
        check('settled: 398 at stitching, 2 written off, card closed', t1Now.status === 'RECEIVED' && F('Stitching').received === 398 && F('Stitching').scrapped === 2 && F('Stitching').short === 0)

        // ── Stitching: 350 done, 10 damaged, 38 still in hand ──
        let inHand = await sorted(mo.id, await at(mo.id, STI, 'WIP'))
        await refuses('damaged pieces need a reason', () => recordWork(tx, mo.id, STI, workSchema.parse({ lines: [{ bundleId: inHand[14].bundleId, damaged: 10 }] }), user.id), 'NO_REASON')
        await recordWork(
          tx,
          mo.id,
          STI,
          workSchema.parse({
            lines: [...inHand.slice(0, 14).map((r) => ({ bundleId: r.bundleId, done: 25 })), { bundleId: inHand[14].bundleId, damaged: 10 }],
            reason: 'needle holes',
            personName: 'Line 3',
          }),
          user.id,
        )
        F = await figures(mo.id)
        const sti = F('Stitching')
        check('stitching reconciles: 398 = 350 done + 10 damaged + 38 in hand', sti.received === 398 && sti.completed === 350 && sti.damaged === 10 && sti.inHand === 38, JSON.stringify({ r: sti.received, c: sti.completed, d: sti.damaged, h: sti.inHand }))

        // ── 200 of the 350 on to Line QC: 150 stay done at stitching ──
        const doneAtSti = await sorted(mo.id, await at(mo.id, STI, 'DONE'))
        const { transfer: t2 } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: STI, lines: doneAtSti.slice(0, 8).map((r) => ({ bundleId: r.bundleId, qty: 25 })) }), user.id)
        F = await figures(mo.id)
        check('200 sent on, 150 still done at stitching — nothing counted twice', F('Stitching').sentOn === 200 && F('Stitching').waiting === 150 && F('Line QC').inTransit === 200)
        await refuses('not more than is there', () => dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: STI, lines: [{ bundleId: inHand[14].bundleId, qty: 16 }] }), user.id), 'NOT_ENOUGH_PIECES')

        // ── Line QC counts in, in two lots ──
        const t2Lines = await tx.processTransferLine.findMany({ where: { transferId: t2.id }, include: { bundle: true }, orderBy: { bundle: { bundleNo: 'asc' } } })
        await receive(tx, t2.id, receiveSchema.parse({ lines: t2Lines.slice(0, 4).map((l) => ({ lineId: l.id, qty: 25 })) }), user.id)
        check('part counted in: partly received', (await tx.processTransfer.findUniqueOrThrow({ where: { id: t2.id } })).status === 'PARTLY_RECEIVED')
        await receive(tx, t2.id, receiveSchema.parse({ lines: t2Lines.slice(4).map((l) => ({ lineId: l.id, qty: 25 })) }), user.id)
        check('the rest counted in: received, no discrepancy', (await tx.processTransfer.findUniqueOrThrow({ where: { id: t2.id } })).status === 'RECEIVED')
        await refuses('a received card cannot be cancelled', () => cancelTransfer(tx, t2.id, 'sent by mistake', user.id), 'ALREADY_RECEIVED')

        // ── QC: 180 pass, 12 rejected, 8 back to stitching for rework ──
        const qcIn = await sorted(mo.id, await at(mo.id, LQC, 'WIP'))
        await refuses('rework goes back, not forward', () => recordWork(tx, mo.id, LQC, workSchema.parse({ lines: [{ bundleId: qcIn[0].bundleId, rework: 1 }], reworkStepId: FQC }), user.id), 'BAD_REWORK_STEP')
        await recordWork(
          tx,
          mo.id,
          LQC,
          workSchema.parse({
            lines: [{ bundleId: qcIn[0].bundleId, done: 5, rejected: 12, rework: 8 }, ...qcIn.slice(1).map((r) => ({ bundleId: r.bundleId, done: 25 }))],
            reworkStepId: STI,
            reason: 'open seams',
          }),
          user.id,
        )
        F = await figures(mo.id)
        check('QC: 200 in, 180 passed, 12 rejected, 8 in rework', F('Line QC').received === 200 && F('Line QC').completed === 180 && F('Line QC').rejected === 12 && F('Line QC').inRework === 8)
        moNow = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id } })
        check('the order shows rework required', moNow.progress === 'REWORK', moNow.progress ?? '')
        let flow = await flowSummary(tx, mo.id)
        check("stitching sees the 8 it has to put right for QC", flow.steps.find((s) => s.id === STI)!.reworkForOthers === 8)

        // Decisions on the 12 rejected: 5 rework, 4 B-grade, 3 written off.
        const rej = qcIn[0].bundleId
        await decide(tx, mo.id, LQC, decideSchema.parse({ from: 'REJECTED', to: 'REWORK', lines: [{ bundleId: rej, qty: 5 }], reworkStepId: STI, reason: 'can be re-stitched' }), { userId: user.id, mayApprove: false })
        await decide(tx, mo.id, LQC, decideSchema.parse({ from: 'REJECTED', to: 'B_GRADE', lines: [{ bundleId: rej, qty: 4 }], reason: 'small stain, sell as seconds' }), { userId: user.id, mayApprove: false })
        await refuses('writing off needs a manager', () => decide(tx, mo.id, LQC, decideSchema.parse({ from: 'REJECTED', to: 'SCRAPPED', lines: [{ bundleId: rej, qty: 3 }], reason: 'torn beyond repair' }), { userId: user.id, mayApprove: false }), 'NEEDS_APPROVAL')
        await decide(tx, mo.id, LQC, decideSchema.parse({ from: 'REJECTED', to: 'SCRAPPED', lines: [{ bundleId: rej, qty: 3 }], reason: 'torn beyond repair' }), { userId: user.id, mayApprove: true })
        await refuses('nothing left to decide on', () => decide(tx, mo.id, LQC, decideSchema.parse({ from: 'REJECTED', to: 'B_GRADE', lines: [{ bundleId: rej, qty: 1 }], reason: 'one more stain' }), { userId: user.id, mayApprove: true }), 'NOT_ENOUGH_PIECES')

        // Rework put right: 13 back to QC to be checked again, then passed.
        await reworkDone(tx, mo.id, LQC, reworkDoneSchema.parse({ lines: [{ bundleId: rej, qty: 13, reworkStepId: STI }], personName: 'Line 3' }), user.id)
        check('reworked pieces go back to be checked', (await at(mo.id, LQC, 'WIP')).reduce((s, r) => s + r.qty, 0) === 13)
        await recordWork(tx, mo.id, LQC, workSchema.parse({ lines: [{ bundleId: rej, done: 13 }] }), user.id)
        F = await figures(mo.id)
        check('reworked garments are not new production: stitching still 350 done', F('Stitching').completed === 350)
        check('QC: 193 passed, 4 B-grade, 3 written off, nothing in rework', F('Line QC').completed === 193 && F('Line QC').bGrade === 4 && F('Line QC').scrapped === 3 && F('Line QC').inRework === 0)

        // ── Leaving steps out ──
        await refuses('a never-skip step cannot be left out', () => skipStep(tx, mo.id, FQC, 'buyer waived it', { userId: user.id, mayApprove: true }), 'CANNOT_SKIP')
        await refuses('cutting cannot be left out', () => skipStep(tx, mo.id, CUT, 'no cutting', { userId: user.id, mayApprove: true }), 'CANNOT_SKIP')
        await refuses('a required step needs a manager', () => skipStep(tx, mo.id, PKG, 'packed at the buyer', { userId: user.id, mayApprove: false }), 'NEEDS_APPROVAL')
        await skipStep(tx, mo.id, FIN, 'no pressing on this order', { userId: user.id, mayApprove: false })
        await restoreStep(tx, mo.id, FIN, { mayApprove: false })
        await skipStep(tx, mo.id, FIN, 'no pressing on this order', { userId: user.id, mayApprove: false })
        const qcDone = await sorted(mo.id, await at(mo.id, LQC, 'DONE'))
        const { transfer: t3 } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: LQC, lines: qcDone }), user.id)
        check('with finishing left out, QC sends straight to final QC', t3.toStepId === FQC)
        await refuses('a left-out step takes no pieces', () => dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: LQC, toStepId: FIN, lines: qcDone }), user.id), 'NOT_NEXT_STEP')

        // ── Final QC: 193 in, 190 pass, 3 rejected and set aside as B-grade ──
        const t3Lines = await tx.processTransferLine.findMany({ where: { transferId: t3.id } })
        await receive(tx, t3.id, receiveSchema.parse({ lines: t3Lines.map((l) => ({ lineId: l.id, qty: l.dispatchedQty })) }), user.id)
        const fqcIn = await sorted(mo.id, await at(mo.id, FQC, 'WIP'))
        let toPass = 190
        await recordWork(
          tx,
          mo.id,
          FQC,
          workSchema.parse({
            lines: fqcIn.map((r, i) => {
              const done = Math.min(r.qty - (i === 0 ? 3 : 0), toPass)
              toPass -= done
              return { bundleId: r.bundleId, done, rejected: i === 0 ? 3 : 0 }
            }),
            reason: 'shade variation',
          }),
          user.id,
        )
        await decide(tx, mo.id, FQC, decideSchema.parse({ from: 'REJECTED', to: 'B_GRADE', lines: [{ bundleId: fqcIn[0].bundleId, qty: 3 }], reason: 'shade, sell as seconds' }), { userId: user.id, mayApprove: false })

        // ── Packing: 190 in and packed ──
        const fqcDone = await sorted(mo.id, await at(mo.id, FQC, 'DONE'))
        const { transfer: t4 } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: FQC, lines: fqcDone }), user.id)
        await receive(tx, t4.id, receiveSchema.parse({ lines: (await tx.processTransferLine.findMany({ where: { transferId: t4.id } })).map((l) => ({ lineId: l.id, qty: l.dispatchedQty })) }), user.id)
        await recordWork(tx, mo.id, PKG, workSchema.parse({ lines: (await at(mo.id, PKG, 'WIP')).map((r) => ({ bundleId: r.bundleId, done: r.qty })) }), user.id)
        const packedBundle = (await at(mo.id, PKG, 'DONE'))[0].bundleId
        await refuses('packing is the last step: nothing goes on from it', () => dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: PKG, lines: [{ bundleId: packedBundle, qty: 1 }] }), user.id), 'LAST_STEP')

        // ── Finished goods: only what the last step passed ──
        await refuses('a receipt for a routed order must name it', () => createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, soId: soA.id, lines: [{ itemId: fg.id, sizeId: S1.id, qty: 1 }] }), user.id), 'PICK_MO')
        await refuses('not more than the last step has passed', () => createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: [{ itemId: fg.id, sizeId: S1.id, qty: 191 }] }), user.id), 'NOT_FINISHED')
        await refuses('nothing of the other size has passed', () => createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: [{ itemId: fg.id, sizeId: S2.id, qty: 1 }] }), user.id), 'NOT_FINISHED')
        const stockA0 = (await balanceOf(tx, { itemId: fg.id, warehouseId: store.id, sizeId: S1.id })).qty
        const fgr = await createFgReceipt(
          tx,
          fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: [{ itemId: fg.id, sizeId: S1.id, qty: 190 }, { itemId: fg.id, sizeId: S1.id, qty: 7, grade: 'B' }] }),
          user.id,
        )
        check('190 first quality into stock', (await balanceOf(tx, { itemId: fg.id, warehouseId: store.id, sizeId: S1.id })).qty === stockA0 + 190)
        check('7 B-grade into stock apart', (await balanceOf(tx, { itemId: fg.id, warehouseId: store.id, sizeId: S1.id, grade: 'B' })).qty >= 7)
        F = await figures(mo.id)
        check('packing: all 190 packed off the floor', F('Packing').packed === 190 && F('Packing').waiting === 0)
        moNow = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id } })
        check('the order counts 197 packed (190 + 7 B-grade)', moNow.totalPackedQty === 197, String(moNow.totalPackedQty))
        await unpackForReceipt(tx, fgr.id, 'test unpack', user.id)
        check('a cancelled receipt puts its pieces back on the last step', (await at(mo.id, PKG, 'DONE')).reduce((s, r) => s + r.qty, 0) === 190)

        // ── Undo ──
        const oldWork = await tx.wipEvent.findFirstOrThrow({ where: { moId: mo.id, stepId: STI, type: 'PROCESS' } })
        await refuses('work whose pieces have moved on cannot be undone', () => undoEvent(tx, oldWork.id, 'typed wrong', user.id), 'NOT_ENOUGH_PIECES')
        const fresh = (await at(mo.id, STI, 'WIP')).find((r) => r.qty === 23)!
        await recordWork(tx, mo.id, STI, workSchema.parse({ lines: [{ bundleId: fresh.bundleId, done: 23 }] }), user.id)
        const freshEv = await tx.wipEvent.findFirstOrThrow({ where: { moId: mo.id, stepId: STI, type: 'PROCESS' }, orderBy: { createdAt: 'desc' } })
        await undoEvent(tx, freshEv.id, 'wrong bundle', user.id)
        check('undone: the 23 are back in hand', (await at(mo.id, STI, 'WIP')).find((r) => r.bundleId === fresh.bundleId)?.qty === 23)
        await refuses('an entry is undone once', () => undoEvent(tx, freshEv.id, 'again', user.id), 'ALREADY_UNDONE')

        // ── Cancel a card nobody has counted in ──
        const doneSti = await sorted(mo.id, await at(mo.id, STI, 'DONE'))
        const { transfer: t5 } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: STI, lines: doneSti.slice(0, 2) }), user.id)
        await cancelTransfer(tx, t5.id, 'sent the wrong bundles', user.id)
        F = await figures(mo.id)
        check('cancelled: the pieces are back at stitching', F('Stitching').waiting === 150 && (await tx.processTransfer.findUniqueOrThrow({ where: { id: t5.id } })).status === 'CANCELLED')

        // ── Hold ──
        await holdMo(tx, mo.id, 'buyer query on the collar', user.id)
        await refuses('nothing moves while on hold', () => dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: STI, lines: doneSti.slice(0, 1) }), user.id), 'ON_HOLD')
        await resumeMo(tx, mo.id)

        // ── The order's own route changed, ahead of the pieces only ──
        steps = await stepsOf(mo.id)
        const asInput = (s: (typeof steps)[number]) => ({ id: s.id, operationId: s.operationId, departmentId: s.departmentId, execution: s.execution, isQcStep: s.isQcStep, skip: s.skip })
        await refuses('a step pieces have been through stays', () => editRoute(tx, mo.id, editRouteSchema.parse({ steps: steps.filter((s) => s.id !== LQC).map(asInput), reason: 'drop line QC' })),
          'ROUTE_FIXED',
        )
        await editRoute(tx, mo.id, editRouteSchema.parse({ steps: [...steps.map(asInput), { operationId: op('OP-KAJ').id, departmentId: op('OP-KAJ').departmentId, skip: 'OPTIONAL' }], reason: 'buyer wants kaj buttons' }))
        steps = await stepsOf(mo.id)
        check('a step added after the last one pieces reached', steps.length === 7 && steps[6].name === 'Kaj Button')
        await editRoute(tx, mo.id, editRouteSchema.parse({ steps: steps.slice(0, 6).map(asInput), reason: 'buyer changed mind' }))
        check('and taken off again', (await stepsOf(mo.id)).length === 6)

        // ── Cutting, batch 2 and 3; cancelling ──
        const c2 = await createCutting(tx, mo.id, cuttingSchema.parse({ fabricItemId: fabric.id, fabricUsed: 400, sizes: [{ sizeId: S1.id, qty: 300 }, { sizeId: S2.id, qty: 300 }], bundleSize: 0 }), user.id)
        const b2 = await tx.productionBundle.findMany({ where: { cuttingOrderId: c2.id }, orderBy: { bundleNo: 'asc' } })
        check('bundle size 0: one bundle per size, numbered on', b2.length === 2 && b2[0].code === `${mo.moNumber}-B017` && b2[0].qty === 300)
        check('1,000 cut in two batches', (await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id } })).totalCutQty === 1000)
        await refuses('all 1,000 cut: no more', () => createCutting(tx, mo.id, cuttingSchema.parse({ ...cutBase, sizes: [{ sizeId: S1.id, qty: 1 }] }), user.id), 'MORE_THAN_PLANNED')
        await cancelCutting(tx, c2.id, 'wrong lay', user.id)
        check('cancelled batch: 400 cut again, its bundles hold nothing', (await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id } })).totalCutQty === 400)
        await refuses('a batch whose bundles moved on cannot be cancelled', () => cancelCutting(tx, c1.id, 'mistake', user.id), 'MOVED_ON')

        // ── The stitching sheet ──
        const sheet = (await stageSheets(tx, { stage: 'STITCHING', show: 'all', page: 1, limit: 500 })).data.find((r) => r.card.mo.id === mo.id)
        check("stitching's sheet: 38 in hand, 150 done waiting, 10 damaged", !!sheet && sheet.figures.inHand === 38 && sheet.figures.waiting === 150 && sheet.figures.damagedNow === 10, JSON.stringify(sheet?.figures))

        // ── Every bundle's pieces add up to what was cut into it ──
        const sums = await tx.wipEntry.groupBy({ by: ['bundleId'], where: { moId: mo.id }, _sum: { qty: true } })
        const qtyOf = new Map((await tx.productionBundle.findMany({ where: { moId: mo.id }, select: { id: true, qty: true, cuttingOrder: { select: { status: true } } } })).map((b) => [b.id, b.cuttingOrder.status === 'CANCELLED' ? 0 : b.qty]))
        check('no piece appears or vanishes: every bundle adds up', sums.every((s) => (s._sum.qty ?? 0) === qtyOf.get(s.bundleId)), JSON.stringify(sums.filter((s) => (s._sum.qty ?? 0) !== qtyOf.get(s.bundleId))))
        flow = await flowSummary(tx, mo.id)
        check('the timeline: 6 steps, bundles, cards, entries', flow.steps.length === 6 && flow.bundles.length === 16 && flow.transfers.length === 5 && flow.events.length > 10)

        // ═══ Order B: a category route with two outside steps ═══
        const soB = await mkOrder(100)
        const moB = await createMo(tx, createMoSchema.parse({ soId: soB.id, routingId: RB.id, release: true, lines: [{ soLineId: soB.lines[0].id, sizes: [{ sizeId: S1.id, qty: 100 }, { sizeId: S2.id, qty: 100 }] }] }), user.id)
        check('created and released with its routing in one go', moB.status === 'RELEASED' && moB.routingId === RB.id)
        const sB = await stepsOf(moB.id)
        const [bCUT, bSTI, bWSH, bEMB] = sB.map((s) => s.id)
        check('outside steps copied as outside', sB[2].execution === 'OUTSOURCED' && sB[3].execution === 'OUTSOURCED')
        await issueFabric(moB.id, 300)
        const cB = await createCutting(tx, moB.id, cuttingSchema.parse({ fabricItemId: fabric.id, fabricUsed: 280, sizes: [{ sizeId: S1.id, qty: 100 }, { sizeId: S2.id, qty: 100 }], bundleSize: 20 }), user.id)
        const bB = await tx.productionBundle.findMany({ where: { cuttingOrderId: cB.id }, orderBy: { bundleNo: 'asc' } })
        const { transfer: tb1 } = await dispatch(tx, moB.id, dispatchSchema.parse({ fromStepId: bCUT, lines: bB.map((b) => ({ bundleId: b.id, qty: 20 })) }), user.id)
        await receive(tx, tb1.id, receiveSchema.parse({ lines: (await tx.processTransferLine.findMany({ where: { transferId: tb1.id } })).map((l) => ({ lineId: l.id, qty: 20 })) }), user.id)
        await recordWork(tx, moB.id, bSTI, workSchema.parse({ lines: bB.map((b) => ({ bundleId: b.id, done: 20 })) }), user.id)

        await refuses('an outside step needs the unit', () => dispatch(tx, moB.id, dispatchSchema.parse({ fromStepId: bSTI, lines: [{ bundleId: bB[0].id, qty: 20 }] }), user.id), 'NO_VENDOR')
        const jwBefore = (await tx.numberSeries.findFirstOrThrow({ where: { docType: 'JW' } })).lastNumber
        const { transfer: wash } = await dispatch(tx, moB.id, dispatchSchema.parse({ fromStepId: bSTI, vendorId: washer, rate: 6, lines: bB.map((b) => ({ bundleId: b.id, qty: 20 })) }), user.id)
        const jwo = await tx.jobWorkOrder.findFirstOrThrow({ where: { moId: moB.id, stepId: bWSH } })
        check('to the washer on a job-work challan (JW series) under a job work order', (await tx.numberSeries.findFirstOrThrow({ where: { docType: 'JW' } })).lastNumber === jwBefore + 1 && wash.jobWorkOrderId === jwo.id && jwo.orderNumber === `${moB.moNumber}-JW1` && Number(jwo.rate) === 6)
        let FB = await figures(moB.id)
        check('200 held by the washer, not in our stores', FB('Washing').atVendor === 200 && FB('Washing').inHand === 0)
        await refuses('the unit cannot return more than it holds', () => vendorReturn(tx, jwo.id, vendorReturnSchema.parse({ lines: [{ bundleId: bB[0].id, accepted: 21 }] }), user.id), 'NOT_ENOUGH_PIECES')
        await refuses('rejected or damaged need a reason', () => vendorReturn(tx, jwo.id, vendorReturnSchema.parse({ lines: [{ bundleId: bB[0].id, accepted: 18, damaged: 2 }] }), user.id), 'NO_REASON')
        await vendorReturn(
          tx,
          jwo.id,
          vendorReturnSchema.parse({
            theirChallanNo: 'CW-55',
            lines: [{ bundleId: bB[0].id, accepted: 10, rejected: 6, damaged: 4 }, ...bB.slice(1).map((b) => ({ bundleId: b.id, accepted: 20 }))],
            reason: 'uneven wash; 4 torn in the drum',
          }),
          user.id,
        )
        const ret1 = await tx.wipEvent.findFirstOrThrow({ where: { jobWorkOrderId: jwo.id, type: 'VENDOR_RETURN' } })
        check('charged for the 190 accepted at ₹6', ret1.chargeQty === 190 && Number(ret1.chargeRate) === 6)
        FB = await figures(moB.id)
        check('washing: 190 done, 6 rejected, 4 damaged, nothing left with the unit', FB('Washing').completed === 190 && FB('Washing').rejected === 6 && FB('Washing').damaged === 4 && FB('Washing').atVendor === 0)
        await sendBack(tx, jwo.id, sendBackSchema.parse({ from: 'REJECTED', lines: [{ bundleId: bB[0].id, qty: 6 }], reason: 'rewash these' }), user.id)
        FB = await figures(moB.id)
        check('6 back with the washer for rework', FB('Washing').atVendor === 6)
        await refuses('a unit holding pieces cannot be closed', () => closeJobWorkOrder(tx, jwo.id), 'STILL_HELD')
        await vendorReturn(tx, jwo.id, vendorReturnSchema.parse({ lines: [{ bundleId: bB[0].id, accepted: 6 }] }), user.id)
        const ret2 = await tx.wipEvent.findFirstOrThrow({ where: { jobWorkOrderId: jwo.id, type: 'VENDOR_RETURN' }, orderBy: { createdAt: 'desc' } })
        check('rework is not charged again', ret2.chargeQty === 0)
        await decide(tx, moB.id, bWSH, decideSchema.parse({ from: 'DAMAGED', to: 'SCRAPPED', lines: [{ bundleId: bB[0].id, qty: 4 }], reason: 'torn, charged to the washer' }), { userId: user.id, mayApprove: true })
        await closeJobWorkOrder(tx, jwo.id)
        await setReturnBill(tx, ret1.id, billSchema.parse({ billNo: 'CW/B/91' }))
        flow = await flowSummary(tx, moB.id)
        const j = flow.jobWorkOrders[0]
        check('the job work order: 200 sent, 196 accepted, 4 damaged, charged ₹1,140, billed', j.sent === 200 && j.accepted === 196 && j.damaged === 4 && j.held === 0 && j.charged === 1140 && j.billed === 1140 && j.status === 'CLOSED', JSON.stringify(j))

        // Embroidery at another unit; its queue shows what it holds.
        const washed = await sorted(moB.id, await at(moB.id, bWSH, 'DONE'))
        await dispatch(tx, moB.id, dispatchSchema.parse({ fromStepId: bWSH, vendorId: embroiderer, rate: 4, lines: washed }), user.id)
        const emb = (await stageSheets(tx, { stage: 'OTHER', show: 'all', page: 1, limit: 500 })).data.find((r) => r.card.mo.id === moB.id && r.step.id === bEMB)
        check("the embroidery sheet shows the 196 the unit holds", emb?.figures.atVendor === 196)
        const jwo2 = await tx.jobWorkOrder.findFirstOrThrow({ where: { moId: moB.id, stepId: bEMB } })
        await vendorReturn(tx, jwo2.id, vendorReturnSchema.parse({ lines: washed.map((r) => ({ bundleId: r.bundleId, accepted: r.qty })) }), user.id)
        FB = await figures(moB.id)
        check('embroidery: 196 back and done', FB('Embroidery').completed === 196 && FB('Embroidery').atVendor === 0)

        // ── Closing an order releases what was asked of the store for it ──
        const soC = await mkOrder(10)
        const moC = await createMo(tx, createMoSchema.parse({ soId: soC.id, routingId: RC.id, release: true, lines: [{ soLineId: soC.lines[0].id, sizes: [{ sizeId: S1.id, qty: 10 }, { sizeId: S2.id, qty: 10 }] }] }), user.id)
        const dept = await tx.department.findFirstOrThrow({ where: { name: 'Cutting' } })
        const mrC = await tx.materialRequisition.create({ data: { mrNumber: `ZZ-MR-${stamp}-C`, moId: moC.id, departmentId: dept.id, status: 'APPROVED', lines: { create: [{ itemId: fabric.id, requestedQty: 5, warehouseId: store.id }] } }, include: { lines: true } })
        await tx.stockReservation.create({ data: { mrId: mrC.id, mrLineId: mrC.lines[0].id, itemId: fabric.id, warehouseId: store.id, reservedQty: 5, qty: 5 } })
        await closeMo(tx, moC.id, user.id, 'buyer cancelled')
        check('closed: its requisition closed and its stock released', !!(await tx.materialRequisition.findUniqueOrThrow({ where: { id: mrC.id } })).closedAt && (await tx.stockReservation.findFirstOrThrow({ where: { mrId: mrC.id } })).status === 'RELEASED')

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
