// Size jumps at stitching, end to end, inside one transaction that always
// throws (nothing is kept): pieces of a bundle cut as one size made as another
// size of the order line at stitching on our own floor. Each change makes a
// new bundle of the new size from the old one; the order's planned sizes and
// the sales order are never edited; finished goods are taken in the revised
// sizes; a change can be undone while its pieces have not moved on.
//
// Covers: no change; one size to another; two sizes swapped both ways in one
// save; several in one save and in two saves; pieces from several bundles and
// lays; pieces changing size only once; from pieces in hand and done;
// part of the order packed before the change; part of a bundle gone on before
// the change; finished goods by revised size; reconciliation; duplicates; two
// saves in a row; undo, undo refused, cancelling a receipt; and every refusal.
//
// Rolled back: everything happens inside one transaction that always throws,
// so nothing is kept and no number series moves. It needs the demo masters
// (FAB-COT-001, FG-SHRT-001, style LD-SH-2601 with a size run of four sizes or
// more, OP-CUT, OP-STI, OP-FIN, OP-PKG). It refuses to run against any database
// that is not on this machine. Run it from apps/api with the demo database
// named explicitly:
//
//   cd apps/api
//   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
//   DIRECT_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
//   npx tsx ../../tools/check-size-change.ts
import { prisma } from '../packages/database/src/index'
import { createSalesOrderSchema, prepareOrder } from '../apps/api/src/routes/sales.routes'
import { createMo, createMoSchema } from '../apps/api/src/routes/production.routes'
import { createFgReceipt, createSchema as fgSchema } from '../apps/api/src/routes/finishedGoods.routes'
import { createCutting, cuttingSchema, cutterIssueSchema, issueToCutter } from '../apps/api/src/services/cutting.service'
import {
  changeSizes,
  decide,
  decideSchema,
  destinationsOf,
  dispatch,
  dispatchSchema,
  holdMo,
  receive,
  receiveSchema,
  receiveWithSizes,
  recordWork,
  sizeChangeSchema,
  undoEvent,
  undoSizeChange,
  unpackForReceipt,
  workSchema,
} from '../apps/api/src/services/floor.service'
import { applyRouting } from '../apps/api/src/services/route.service'
import { jobCardDetail } from '../apps/api/src/services/jobCard.service'
import { netSizeChanges, orderSizes, sizeChangeHistory } from '../apps/api/src/services/sizeChanges.service'
import { balancesOf } from '../apps/api/src/services/wip.service'
import { assertStockUnused, balanceOf, recordMovement } from '../apps/api/src/services/stock.service'
import { syncMoPacked } from '../apps/api/src/services/manufacturing.service'
import { voidForCancelledReceipt } from '../apps/api/src/services/garment.service'
import { lockRow } from '../apps/api/src/lib/lockRow'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const stamp = Date.now().toString(36)

/** Only ever on this machine: the .env files point at the live database. */
function refuseUnlessLocal() {
  for (const name of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    const url = process.env[name]
    if (!url && name === 'DIRECT_URL') continue
    let host = ''
    try {
      host = new URL(url ?? '').hostname
    } catch {
      host = ''
    }
    if (host !== 'localhost' && host !== '127.0.0.1') {
      throw new Error(
        `Refusing to run: ${name} points at "${host || 'nothing'}", not a database on this machine. Set DATABASE_URL and DIRECT_URL to the demo database (postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp) and run again.`,
      )
    }
  }
}

type SizeFig = { stepId: string; state: string; received: number; inHand: number; waiting: number; completed: number; sentOn: number; yetToCome: number; sizeIn: number; sizeOut: number }

async function main() {
  refuseUnlessLocal()

  const cust = await prisma.customer.findFirst({ where: { isActive: true, isBlacklisted: false, OR: [{ shippingStateCode: { not: null } }, { billingStateCode: { not: null } }] }, select: { id: true } })
  const brand = await prisma.brand.findFirst({ where: { isActive: true } })
  const fabric = await prisma.item.findUnique({ where: { code: 'FAB-COT-001' } })
  const fgTemplate = await prisma.item.findUnique({ where: { code: 'FG-SHRT-001' } })
  const store = await prisma.warehouse.findFirst({ where: { isActive: true }, select: { id: true } })
  const user = await prisma.user.findFirst({ select: { id: true } })
  const style = await prisma.style.findUnique({ where: { code: 'LD-SH-2601' }, include: { sizeGroup: { include: { sizes: true } } } })
  const ops = new Map((await prisma.operation.findMany({ select: { id: true, code: true, kind: true, departmentId: true } })).map((o) => [o.code, o]))
  if (!cust || !brand || !fabric || !fgTemplate || !store || !user || !style?.sizeGroup) throw new Error('test data missing')
  if (!['OP-CUT', 'OP-STI', 'OP-FIN', 'OP-PKG'].every((c) => ops.has(c))) throw new Error('test data missing: OP-CUT, OP-STI, OP-FIN and OP-PKG are needed')
  const run = [...style.sizeGroup.sizes].sort((a, b) => a.sequence - b.sequence)
  if (run.length < 4) throw new Error('LD-SH-2601 needs a size run of at least four sizes')
  const [S1, S2, S3, S4] = run
  const SIZES = [S1, S2, S3]
  const op = (code: string) => ops.get(code)!
  const seriesBefore = JSON.stringify(await prisma.numberSeries.findMany({ select: { docType: true, lastNumber: true }, orderBy: { docType: 'asc' } }))

  try {
    await prisma.$transaction(
      async (tx) => {
        // A refused call runs inside a savepoint and is rolled back to it, as
        // its own request's transaction would be. One that is wrongly allowed
        // is rolled back too, so the checks after it still see the true state.
        const refuses = async (label: string, run: () => Promise<unknown>, code: string) => {
          await tx.$executeRawUnsafe('SAVEPOINT refused')
          try {
            await run()
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refused')
            check(label, false, 'was allowed')
            return null
          } catch (e) {
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refused')
            const err = e as { code?: string; message?: string }
            check(label, err.code === code, `${err.code}: ${err.message}`)
            return err
          }
        }

        // ── Fixtures: two colours of LD-SH-2601, an order, a route ──
        const colorA = 'ZZ Test Grey'
        const colorB = 'ZZ Test Blue'
        await tx.style.update({ where: { id: style.id }, data: { category: 'Shirt', colors: { push: [colorA, colorB] } } })
        const taxRateId = fgTemplate.taxRateId ?? (await tx.taxRate.findFirstOrThrow({ where: { rate: 5 } })).id
        const mkFg = (suffix: string, color: string) =>
          tx.item.create({
            data: { code: `ZZ-FG-${stamp}-${suffix}`, name: `Test shirt ${color}`, type: 'FINISHED_GOOD', categoryId: fgTemplate.categoryId, uomId: fgTemplate.uomId, styleId: style.id, color, standardRate: 250, hsnCode: fgTemplate.hsnCode ?? '6205', taxRateId },
          })
        const fgA = await mkFg('A', colorA)
        const fgB = await mkFg('B', colorB)
        const sizesA = [{ sizeId: S1.id, qty: 100 }, { sizeId: S2.id, qty: 100 }, { sizeId: S3.id, qty: 100 }]
        const sizesB = [{ sizeId: S1.id, qty: 10 }, { sizeId: S2.id, qty: 10 }]
        const { header, lines } = await prepareOrder(
          tx,
          createSalesOrderSchema.parse({
            customerId: cust.id,
            brandId: brand.id,
            customerPORef: 'LDCM-SJ',
            lines: [
              { itemId: fgA.id, color: colorA, totalQty: 300, unitPrice: 300, sizes: sizesA },
              { itemId: fgB.id, color: colorB, totalQty: 20, unitPrice: 300, sizes: sizesB },
            ],
          }),
        )
        const so = await tx.salesOrder.create({ data: { ...header, soNumber: `ZZ-SO-${stamp}`, status: 'CONFIRMED', createdById: user.id, lines: { create: lines } }, include: { lines: true } })
        const soLineA = so.lines.find((l) => l.itemId === fgA.id)!
        const soLineB = so.lines.find((l) => l.itemId === fgB.id)!
        const soSizes = async () =>
          JSON.stringify(await tx.salesOrderLineSize.findMany({ where: { line: { soId: so.id } }, select: { lineId: true, sizeId: true, qty: true }, orderBy: [{ lineId: 'asc' }, { sizeId: 'asc' }] }))
        const soSizes0 = await soSizes()
        const routing = await tx.routing.create({
          data: {
            code: `ZZ-RT-${stamp}`,
            name: 'Size jump test route',
            styleId: style.id,
            steps: {
              create: (['OP-CUT', 'OP-STI', 'OP-FIN', 'OP-PKG'] as const).map((c, i) => ({
                sequence: i + 1,
                operationId: op(c).id,
                departmentId: op(c).departmentId,
                execution: 'IN_HOUSE' as const,
                skip: 'WITH_APPROVAL' as const,
                isQcStep: op(c).kind === 'QC',
              })),
            },
          },
        })
        const mo = await createMo(tx, createMoSchema.parse({ soId: so.id, release: true, lines: [{ soLineId: soLineA.id, sizes: sizesA }, { soLineId: soLineB.id, sizes: sizesB }] }), user.id)
        await applyRouting(tx, mo.id, routing.id)
        const steps = await tx.mOStep.findMany({ where: { moId: mo.id }, orderBy: { sequence: 'asc' } })
        const [CUT, STI, FIN, PKG] = steps.map((s) => s.id)
        check('setup: the order has its four stages, stitching on our own floor', steps.length === 4 && steps[1].kind === 'STITCHING' && steps[1].execution === 'IN_HOUSE', steps.map((s) => s.name).join(' → '))
        const lineA = await tx.mOLine.findFirstOrThrow({ where: { moId: mo.id, soLineId: soLineA.id } })
        const lineB = await tx.mOLine.findFirstOrThrow({ where: { moId: mo.id, soLineId: soLineB.id } })
        const cardA = await tx.jobCard.findUniqueOrThrow({ where: { moLineId: lineA.id } })
        const cardB = await tx.jobCard.findUniqueOrThrow({ where: { moLineId: lineB.id } })
        const moSizes = async () =>
          JSON.stringify(await tx.mOLineSize.findMany({ where: { moLine: { moId: mo.id } }, select: { moLineId: true, sizeId: true, qty: true }, orderBy: [{ moLineId: 'asc' }, { sizeId: 'asc' }] }))
        const moSizes0 = await moSizes()

        // ── Materials issued, then cut: grey in two lays (bundles of 25), blue in one ──
        const dept = await tx.department.findFirstOrThrow({ where: { name: 'Cutting' } })
        await tx.materialRequisition.create({
          data: { mrNumber: `ZZ-MR-${stamp}`, moId: mo.id, departmentId: dept.id, status: 'APPROVED', issuedAt: new Date(), lines: { create: [{ itemId: fabric.id, requestedQty: 500, issuedQty: 500, warehouseId: store.id }] } },
        })
        const cut = async (moLineId: string, cutterName: string, lotNo: string, sizes: Array<{ sizeId: string; qty: number }>, bundleSize: number) => {
          const issue = await issueToCutter(tx, mo.id, cutterIssueSchema.parse({ moLineId, cutterName, lotNo, fabricItemId: fabric.id, planned: sizes }), user.id)
          await createCutting(tx, mo.id, cuttingSchema.parse({ fabricItemId: fabric.id, fabricUsed: 100, bundleSize, sizes }), user.id, { issueId: issue.id })
          return issue
        }
        const lay1 = await cut(lineA.id, 'Ramesh', 'LOT-1', [{ sizeId: S1.id, qty: 100 }, { sizeId: S2.id, qty: 100 }, { sizeId: S3.id, qty: 50 }], 25)
        const lay2 = await cut(lineA.id, 'Suresh', 'LOT-2', [{ sizeId: S3.id, qty: 50 }], 25)
        const layB = await cut(lineB.id, 'Ramesh', 'LOT-3', sizesB, 0)
        const cutBundles = await tx.productionBundle.findMany({ where: { moId: mo.id }, orderBy: { bundleNo: 'asc' } })
        const pick = (moLineId: string, sizeId: string, layId: string) => cutBundles.filter((b) => b.moLineId === moLineId && b.sizeId === sizeId && b.cuttingOrderId === layId)
        const [A1, A2, A3, A4] = pick(lineA.id, S1.id, lay1.id)
        const [A5, A6, A7, A8] = pick(lineA.id, S2.id, lay1.id)
        const [A9, A10] = pick(lineA.id, S3.id, lay1.id)
        const [A11, A12] = pick(lineA.id, S3.id, lay2.id)
        const [B1] = pick(lineB.id, S1.id, layB.id)
        const [B2] = pick(lineB.id, S2.id, layB.id)
        const grey = [A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12]
        check(
          'setup: 12 bundles of 25 on the grey job card from two lays, 2 on the blue',
          cutBundles.length === 14 && grey.every((b) => b?.qty === 25) && B1?.qty === 10 && B2?.qty === 10,
          `${cutBundles.length} bundles`,
        )
        const sizeOfBundle = new Map(cutBundles.map((b) => [b.id, b.sizeId!]))
        const codeOf = new Map(cutBundles.map((b) => [b.id, b.code]))

        // ── Helpers ──
        const held = async (stepId: string, bundleId: string, bucket?: 'WIP' | 'DONE' | 'PACKED') =>
          (await balancesOf(tx, mo.id)).filter((r) => r.stepId === stepId && r.bundleId === bundleId && !r.vendorId && (!bucket || r.bucket === bucket)).reduce((s, r) => s + r.qty, 0)
        const readyAt = async (stepId: string, moLineId: string) => {
          const by = new Map<string, number>()
          for (const r of await balancesOf(tx, mo.id, moLineId)) {
            if (r.stepId === stepId && !r.vendorId && (r.bucket === 'WIP' || r.bucket === 'DONE')) by.set(r.bundleId, (by.get(r.bundleId) ?? 0) + r.qty)
          }
          return [...by].filter(([, q]) => q > 0).map(([bundleId, qty]) => ({ bundleId, qty }))
        }
        /** Sent on to the next step and counted in there in full. */
        const sendOn = async (fromStepId: string, rows: Array<{ bundleId: string; qty: number }>) => {
          const out = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId, lines: rows }), user.id)
          if (!(out as { sameDepartment?: boolean }).sameDepartment) {
            const ls = await tx.processTransferLine.findMany({ where: { transferId: out.transfer.id } })
            await receive(tx, out.transfer.id, receiveSchema.parse({ lines: ls.map((l) => ({ lineId: l.id, qty: l.dispatchedQty })) }), user.id)
          }
          return out.transfer
        }
        const card = () => jobCardDetail(tx, cardA.id)
        type Card = Awaited<ReturnType<typeof card>>
        const stepFig = (d: Card, stepId: string) => d.steps.find((s) => s.id === stepId)!.figures!
        const sizeFig = (d: Card, sizeId: string, stepId: string) => (d.sizeFigures[sizeId] as unknown as SizeFig[]).find((f) => f.stepId === stepId)!
        const totalsOf = (d: Card) => JSON.stringify(d.steps.map((s) => s.figures))
        const lastNo = async () => (await tx.productionBundle.aggregate({ where: { moId: mo.id }, _max: { bundleNo: true } }))._max.bundleNo ?? 0
        const codeFor = (no: number) => `${mo.moNumber}-B${String(no).padStart(3, '0')}`

        // What the sizes should be: planned, plus every change not undone.
        type Line = [{ id: string }, { id: string }, number]
        const plannedA = new Map(sizesA.map((z) => [z.sizeId, z.qty]))
        const net = new Map(SIZES.map((z) => [z.id, 0]))
        const inAt = new Map(SIZES.map((z) => [z.id, 0]))
        const outAt = new Map(SIZES.map((z) => [z.id, 0]))
        const expect = (ls: Line[], sign = 1) => {
          for (const [b, z, qty] of ls) {
            const from = sizeOfBundle.get(b.id)!
            net.set(from, net.get(from)! - sign * qty)
            net.set(z.id, net.get(z.id)! + sign * qty)
            outAt.set(from, outAt.get(from)! + sign * qty)
            inAt.set(z.id, inAt.get(z.id)! + sign * qty)
          }
        }
        const revisedOf = (sizeId: string) => plannedA.get(sizeId)! + net.get(sizeId)!
        const input = (ls: Line[], reason: string, extra: { clientKey?: string; personName?: string; stepId?: string } = {}) =>
          sizeChangeSchema.parse({ stepId: extra.stepId ?? STI, lines: ls.map(([b, z, qty]) => ({ bundleId: b.id, toSizeId: z.id, qty })), reason, personName: extra.personName, clientKey: extra.clientKey })
        const save = async (ls: Line[], reason: string, extra: { clientKey?: string; personName?: string } = {}) => {
          const out = await changeSizes(tx, mo.id, input(ls, reason, extra), user.id)
          if (!out.duplicate) expect(ls)
          return out
        }
        const checkRevised = async (label: string) => {
          const os = (await orderSizes(tx, mo.id)).find((l) => l.moLineId === lineA.id)!
          const [byMo, byLine] = await Promise.all([netSizeChanges(tx, { moId: mo.id }), netSizeChanges(tx, { moLineId: lineA.id })])
          const ok = SIZES.every((z) => {
            const r = os.sizes.find((s) => s.sizeId === z.id)!
            return r.planned === plannedA.get(z.id) && r.changed === net.get(z.id) && r.revised === revisedOf(z.id) && byMo(lineA.id, z.id) === net.get(z.id) && byLine(lineA.id, z.id) === net.get(z.id)
          })
          check(label, ok, os.sizes.map((s) => `${s.code}: ${s.planned} planned, ${s.revised} revised`).join('; '))
        }

        // ── Cutting → stitching: grey counted in; blue left on its card ──
        await sendOn(CUT, grey.map((b) => ({ bundleId: b.id, qty: b.qty })))
        const { transfer: toStiBlue } = await dispatch(tx, mo.id, dispatchSchema.parse({ fromStepId: CUT, lines: [B1, B2].map((b) => ({ bundleId: b.id, qty: b.qty })) }), user.id)

        // ── 6 (before): one bundle of size 2 goes all the way and is packed ──
        await sendOn(STI, [{ bundleId: A8.id, qty: 25 }])
        await sendOn(FIN, [{ bundleId: A8.id, qty: 25 }])
        const r1 = await createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: [{ itemId: fgA.id, sizeId: S2.id, qty: 25 }] }), user.id)
        const r1Lines0 = JSON.stringify(r1.lines.map((l) => ({ itemId: l.itemId, sizeId: l.sizeId, qty: Number(l.qty) })))
        check('6. before any size change: 25 of size 2 packed into finished goods', (await balanceOf(tx, { itemId: fgA.id, warehouseId: store.id, sizeId: S2.id })).qty === 25 && (await held(PKG, A8.id, 'PACKED')) === 25)

        // ═══ 1. No size change ═══
        let jc = await card()
        const totals0 = totalsOf(jc)
        const os0 = (await orderSizes(tx, mo.id)).find((l) => l.moLineId === lineA.id)!
        check(
          '1. no size change: every size revised = planned, nothing moved, no history',
          os0.sizes.every((s) => s.changed === 0 && s.revised === s.planned) &&
            os0.sizes.find((s) => s.sizeId === S2.id)!.packed === 25 &&
            os0.sizes.find((s) => s.sizeId === S2.id)!.toPack === 75 &&
            (await sizeChangeHistory(tx, { moId: mo.id })).length === 0 &&
            jc.sizeChanges.length === 0 &&
            jc.lines[0].sizes.every((s) => s.changed === 0),
          os0.sizes.map((s) => `${s.code} ${s.planned}/${s.revised}/${s.packed}`).join('; '),
        )
        check(
          '1. stitching: each size received as cut, nothing moved in or out',
          SIZES.every((z) => sizeFig(jc, z.id, STI).received === 100 && sizeFig(jc, z.id, STI).sizeIn === 0 && sizeFig(jc, z.id, STI).sizeOut === 0),
        )
        check(
          '1. finishing waits for each size as planned (size 2 less the 25 gone through)',
          sizeFig(jc, S1.id, FIN).yetToCome === 100 && sizeFig(jc, S2.id, FIN).yetToCome === 75 && sizeFig(jc, S3.id, FIN).yetToCome === 100,
          SIZES.map((z) => sizeFig(jc, z.id, FIN).yetToCome).join('/'),
        )
        check('1. the job card totals: 300 cut, 275 in hand at stitching', stepFig(jc, CUT).completed === 300 && stepFig(jc, STI).inHand === 275 && jc.lines[0].totalQty === 300)

        // ═══ 12 (first part). A change, undone: revised back to planned ═══
        const L0: Line[] = [[A5, S3, 5]]
        const s0 = await save(L0, 'Measured big at the line')
        await checkRevised('12. a change moves the revised sizes (size 2 −5, size 3 +5)')
        const c0 = s0.bundleIds[0]
        check('12. the job card totals do not move with a size change', totalsOf(await card()) === totals0)
        await undoSizeChange(tx, s0.eventId, 'Measured again: they were right', user.id)
        expect(L0, -1)
        const sc0 = await tx.sizeChange.findFirstOrThrow({ where: { eventId: s0.eventId } })
        check('12. undone: the 5 are back in their bundle, the new bundle holds none', (await held(STI, A5.id, 'WIP')) === 25 && (await held(STI, c0)) === 0)
        check(
          '12. the change stays on record as undone, with who and why',
          !!sc0.undoneAt && sc0.undoneById === user.id && sc0.undoReason === 'Measured again: they were right' && !!(await tx.wipEvent.findUniqueOrThrow({ where: { id: s0.eventId } })).reversedAt,
        )
        await checkRevised('12. undone: every size is back to its planned count')
        jc = await card()
        check('12. the undone bundle is not listed on the job card; totals as before', !jc.bundles.some((b) => b.id === c0) && totalsOf(jc) === totals0)
        await refuses('12. a size change is undone only once', () => undoSizeChange(tx, s0.eventId, 'twice over', user.id), 'ALREADY_UNDONE')

        // ═══ The floor's swap, in one save: 20 of size 1 made as size 2 and 25 of size 2 made as
        // size 1 (38 → 40 20 pcs, 40 → 38 25 pcs), from five bundles. Tried, then rolled back. ═══
        await tx.$executeRawUnsafe('SAVEPOINT swap')
        {
          const noSwap = await lastNo()
          const sw = await changeSizes(
            tx,
            mo.id,
            input([[A1, S2, 10], [A2, S2, 10], [A5, S1, 10], [A6, S1, 10], [A7, S1, 5]], 'Size 1 measured as size 2, and size 2 as size 1'),
            user.id,
          )
          const made = await tx.productionBundle.findMany({ where: { id: { in: sw.bundleIds } }, orderBy: { bundleNo: 'asc' } })
          const os = (await orderSizes(tx, mo.id)).find((l) => l.moLineId === lineA.id)!
          const rev = (z: { id: string }) => os.sizes.find((s) => s.sizeId === z.id)!.revised
          const swapCard = await card()
          check(
            'swap: one save takes 20 of size 1 to size 2 and 25 of size 2 to size 1, into 5 new bundles',
            (await tx.sizeChange.count({ where: { eventId: sw.eventId } })) === 5 &&
              made.length === 5 &&
              made.every((b, i) => b.bundleNo === noSwap + 1 + i && b.splitAtStepId === STI) &&
              made.filter((b) => b.sizeId === S2.id).length === 2 &&
              made.filter((b) => b.sizeId === S1.id).length === 3,
            made.map((b) => `${b.code} ${b.qty}`).join(', '),
          )
          const kept = await Promise.all([A1, A2, A5, A6, A7].map((b) => held(STI, b.id, 'WIP')))
          const took = await Promise.all(made.map((b) => held(STI, b.id, 'WIP')))
          check(
            'swap: each old bundle holds what it kept, each new bundle what it took',
            kept.join('/') === '15/15/15/15/20' && took.every((q, i) => q === made[i].qty) && took.reduce((s, q) => s + q, 0) === 45,
            `kept ${kept.join('/')}; took ${took.join('/')}`,
          )
          check(
            'swap: size 1 = 100 − 20 + 25 = 105, size 2 = 100 − 25 + 20 = 95, size 3 untouched; still 300 in all',
            rev(S1) === 105 && rev(S2) === 95 && rev(S3) === 100,
            `${rev(S1)}/${rev(S2)}/${rev(S3)}`,
          )
          check(
            'swap: stitching shows both ways (size 1 in 25, out 20; size 2 in 20, out 25); the job card totals do not move',
            sizeFig(swapCard, S1.id, STI).sizeIn === 25 &&
              sizeFig(swapCard, S1.id, STI).sizeOut === 20 &&
              sizeFig(swapCard, S2.id, STI).sizeIn === 20 &&
              sizeFig(swapCard, S2.id, STI).sizeOut === 25 &&
              totalsOf(swapCard) === totals0,
          )
        }
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT swap')
        await checkRevised('swap rolled back: every size is back to its planned count')

        // ═══ 2. One size to another: 20 of B001 (size 1) made as size 2 ═══
        const no1 = await lastNo()
        const k1 = `k-size-1-${stamp}`
        const L1: Line[] = [[A1, S2, 20]]
        const s1 = await save(L1, 'Panels cut large, made as the next size', { clientKey: k1, personName: 'Line 3' })
        const C1 = await tx.productionBundle.findUniqueOrThrow({ where: { id: s1.bundleIds[0] } })
        check(
          `2. a new bundle for the 20: made from ${A1.code} at stitching, numbered next, size 2, same lay`,
          s1.bundleIds.length === 1 &&
            C1.parentId === A1.id &&
            C1.splitAtStepId === STI &&
            C1.bundleNo === no1 + 1 &&
            C1.code === codeFor(no1 + 1) &&
            C1.sizeId === S2.id &&
            C1.qty === 20 &&
            C1.moLineId === lineA.id &&
            C1.cuttingOrderId === A1.cuttingOrderId,
          `${C1.code} size ${C1.sizeId === S2.id ? S2.code : C1.sizeId} qty ${C1.qty}`,
        )
        const sc1 = await tx.sizeChange.findMany({ where: { eventId: s1.eventId } })
        check(
          '2. one size-change row: from bundle and size, to bundle and size, pieces, reason, who',
          sc1.length === 1 &&
            sc1[0].moId === mo.id &&
            sc1[0].moLineId === lineA.id &&
            sc1[0].stepId === STI &&
            sc1[0].fromBundleId === A1.id &&
            sc1[0].toBundleId === C1.id &&
            sc1[0].fromSizeId === S1.id &&
            sc1[0].toSizeId === S2.id &&
            sc1[0].qty === 20 &&
            sc1[0].reason === 'Panels cut large, made as the next size' &&
            sc1[0].createdById === user.id &&
            !sc1[0].undoneAt,
        )
        const ev1 = await tx.wipEvent.findUniqueOrThrow({ where: { id: s1.eventId }, include: { entries: true } })
        check(
          '2. one SIZE_CHANGE entry at stitching; the new bundle’s pieces carry the new size',
          ev1.type === 'SIZE_CHANGE' &&
            ev1.stepId === STI &&
            ev1.personName === 'Line 3' &&
            ev1.entries.filter((e) => e.bundleId === C1.id).every((e) => e.sizeId === S2.id && e.qty > 0) &&
            ev1.entries.filter((e) => e.bundleId === A1.id).every((e) => e.sizeId === S1.id && e.qty < 0) &&
            ev1.entries.reduce((s, e) => s + e.qty, 0) === 0,
        )
        check(`2. ${A1.code} keeps 5 in hand, the new bundle holds 20`, (await held(STI, A1.id, 'WIP')) === 5 && (await held(STI, C1.id, 'WIP')) === 20)
        await checkRevised('2. revised: size 1 down 20, size 2 up 20')
        jc = await card()
        check('2. the job card totals are unchanged', totalsOf(jc) === totals0 && jc.lines[0].totalQty === 300)
        check('2. the order’s planned sizes and the sales order are not touched', (await moSizes()) === moSizes0 && (await soSizes()) === soSizes0)
        check(
          '2. stitching by size: size 1 shows 20 out, size 2 shows 20 in',
          sizeFig(jc, S1.id, STI).sizeOut === 20 && sizeFig(jc, S1.id, STI).sizeIn === 0 && sizeFig(jc, S2.id, STI).sizeIn === 20 && sizeFig(jc, S2.id, STI).sizeOut === 0 && sizeFig(jc, S3.id, STI).sizeIn + sizeFig(jc, S3.id, STI).sizeOut === 0,
        )
        check(
          '2. in hand at stitching by size: 80 of size 1, 95 of size 2, 100 of size 3',
          sizeFig(jc, S1.id, STI).inHand === 80 && sizeFig(jc, S2.id, STI).inHand === 95 && sizeFig(jc, S3.id, STI).inHand === 100,
          SIZES.map((z) => sizeFig(jc, z.id, STI).inHand).join('/'),
        )
        check(
          '2. later steps wait for the revised counts: finishing 80 / 95 / 100, packing the same',
          [FIN, PKG].every((st) => sizeFig(jc, S1.id, st).yetToCome === 80 && sizeFig(jc, S2.id, st).yetToCome === 95 && sizeFig(jc, S3.id, st).yetToCome === 100),
          [FIN, PKG].map((st) => SIZES.map((z) => sizeFig(jc, z.id, st).yetToCome).join('/')).join(' · '),
        )
        check('2. stitching still has nothing of any size yet to come', SIZES.every((z) => sizeFig(jc, z.id, STI).yetToCome === 0))
        const listed = jc.bundles.find((b) => b.id === C1.id)
        check(
          '2. the job card lists the new bundle with the bundle and size it came from',
          !!listed && listed.parent?.id === A1.id && listed.parent?.code === A1.code && listed.parent?.size === S1.code && listed.madeAtStepId === STI && listed.undone === false,
        )
        const h1 = (await sizeChangeHistory(tx, { moId: mo.id })).find((h) => h.eventId === s1.eventId)
        check(
          '2. the history shows it: step, reason, who, and the move',
          !!h1 &&
            h1.step.id === STI &&
            h1.reason === 'Panels cut large, made as the next size' &&
            h1.personName === 'Line 3' &&
            !h1.undone &&
            h1.moves.length === 1 &&
            h1.moves[0].from.code === A1.code &&
            h1.moves[0].from.size === S1.code &&
            h1.moves[0].to.code === C1.code &&
            h1.moves[0].to.size === S2.code &&
            h1.moves[0].qty === 20,
        )
        check('2. nothing is posted to stock by a size change', (await tx.stockLedger.count({ where: { itemId: fgA.id } })) === 1)

        // ═══ 10. Duplicates ═══
        const bundlesBefore = await tx.productionBundle.count({ where: { moId: mo.id } })
        const dup = await changeSizes(tx, mo.id, input(L1, 'Panels cut large, made as the next size', { clientKey: k1 }), user.id)
        check(
          '10. the same save sent twice is recorded once',
          dup.duplicate === true &&
            dup.eventId === s1.eventId &&
            JSON.stringify(dup.bundleIds) === JSON.stringify(s1.bundleIds) &&
            (await tx.productionBundle.count({ where: { moId: mo.id } })) === bundlesBefore &&
            (await tx.sizeChange.count({ where: { moId: mo.id } })) === 2,
        )
        await refuses(`10. pieces moved once cannot be moved again (${A1.code} has 5 left, 20 asked)`, () => changeSizes(tx, mo.id, input(L1, 'Sent again by mistake'), user.id), 'NOT_ENOUGH_PIECES')
        await checkRevised('10. still only one change of 20 counted')

        // ═══ Refusals ═══
        const one = (b: { id: string }, z: { id: string }, qty = 1): Line[] => [[b, z, qty]]
        await refuses('refused: not at a step other than stitching (finishing)', () => changeSizes(tx, mo.id, input(one(A5, S3), 'Wrong step', { stepId: FIN }), user.id), 'NOT_AT_STITCHING')
        await refuses('refused: not at cutting', () => changeSizes(tx, mo.id, input(one(A5, S3), 'Wrong step', { stepId: CUT }), user.id), 'NOT_AT_STITCHING')
        await refuses(
          `refused: pieces given to an outside unit for stitching, though the step is our own floor (${A5.code})`,
          async () => {
            const unit = await tx.supplier.findFirstOrThrow({ where: { isActive: true }, select: { id: true } })
            await tx.processTransfer.create({
              data: { transferNumber: `ZZ-JW-${stamp}`, moId: mo.id, fromStepId: CUT, toStepId: STI, vendorId: unit.id, status: 'RECEIVED', createdById: user.id, lines: { create: [{ bundleId: A5.id, dispatchedQty: 5, receivedQty: 5 }] } },
            })
            return changeSizes(tx, mo.id, input(one(A5, S3), 'Came back from a unit'), user.id)
          },
          'STITCHED_OUTSIDE',
        )
        await refuses(
          'refused: stitching done by an outside unit',
          async () => {
            await tx.mOStep.update({ where: { id: STI }, data: { execution: 'OUTSOURCED' } })
            return changeSizes(tx, mo.id, input(one(A5, S3), 'At the unit'), user.id)
          },
          'NOT_AT_STITCHING',
        )
        await refuses(`refused: size ${S4.code} is not on the order line`, () => changeSizes(tx, mo.id, input(one(A5, S4), 'Not on order'), user.id), 'NOT_ON_ORDER')
        await refuses('refused: the size it already is', () => changeSizes(tx, mo.id, input(one(A5, S2), 'Same size'), user.id), 'SAME_SIZE')
        await refuses(`refused: more than in hand and done (${A5.code}: 25, 26 asked)`, () => changeSizes(tx, mo.id, input(one(A5, S3, 26), 'Too many'), user.id), 'NOT_ENOUGH_PIECES')
        await refuses(
          'refused: damaged pieces waiting for a decision are not counted (23 left of 25, 24 asked)',
          async () => {
            await recordWork(tx, mo.id, STI, workSchema.parse({ lines: [{ bundleId: A6.id, damaged: 2 }], reason: 'needle holes' }), user.id)
            return changeSizes(tx, mo.id, input(one(A6, S1, 24), 'Too many'), user.id)
          },
          'NOT_ENOUGH_PIECES',
        )
        await refuses(`refused: pieces on a transfer card not counted in yet (${B1.code})`, () => changeSizes(tx, mo.id, input(one(B1, S2), 'Still on the way'), user.id), 'NOT_ENOUGH_PIECES')
        await refuses(
          'refused: an order on hold',
          async () => {
            await holdMo(tx, mo.id, 'Buyer asked to wait', user.id)
            return changeSizes(tx, mo.id, input(one(A5, S3), 'On hold'), user.id)
          },
          'ON_HOLD',
        )
        await refuses('refused: bundles of two colours in one save', () => changeSizes(tx, mo.id, input([...one(A5, S3), ...one(B1, S2)], 'Two colours'), user.id), 'ONE_JOB_CARD')
        await refuses('refused: a bundle that is not on the order', () => changeSizes(tx, mo.id, sizeChangeSchema.parse({ stepId: STI, lines: [{ bundleId: 'not-a-bundle', toSizeId: S3.id, qty: 1 }], reason: 'No such bundle' }), user.id), 'BAD_BUNDLE')
        await refuses('refused: nothing entered (every line nought)', () => changeSizes(tx, mo.id, input(one(A5, S3, 0), 'Nothing at all'), user.id), 'NOTHING_RECORDED')
        const shortReason = sizeChangeSchema.safeParse({ stepId: STI, lines: [{ bundleId: A5.id, toSizeId: S3.id, qty: 1 }], reason: 'abc' })
        check('refused: a reason of under five letters', !shortReason.success && shortReason.error.issues.some((i) => i.path[0] === 'reason'))
        const noReason = sizeChangeSchema.safeParse({ stepId: STI, lines: [{ bundleId: A5.id, toSizeId: S3.id, qty: 1 }] })
        check('refused: no reason at all', !noReason.success)
        check(
          'refusals leave nothing behind: no new bundles, rows or entries; stitching still in our hands; order not on hold',
          (await tx.productionBundle.count({ where: { moId: mo.id } })) === bundlesBefore &&
            (await tx.sizeChange.count({ where: { moId: mo.id } })) === 2 &&
            (await tx.mOStep.findUniqueOrThrow({ where: { id: STI } })).execution === 'IN_HOUSE' &&
            !(await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id } })).heldAt &&
            (await held(STI, A6.id, 'WIP')) === 25,
        )

        // Pieces change size once: a new bundle's pieces were already made as another size.
        await refuses(`refused: a new bundle's pieces change size only once (${C1.code}, made from ${A1.code})`, () => changeSizes(tx, mo.id, input([[C1, S3, 2]], 'Made as size 3 after all'), user.id), 'ALREADY_CHANGED')

        // ═══ Count in with a size change, in one save (the Count in window at stitching) ═══
        // Tried in a savepoint and undone, so the blue card goes on below exactly as before.
        {
          const lines0 = await tx.processTransferLine.findMany({ where: { transferId: toStiBlue.id } })
          const all = lines0.map((l) => ({ lineId: l.id, qty: l.dispatchedQty }))
          const withSizes = (qty: number) =>
            receiveSchema.parse({ lines: all, receivedBy: 'Sunita', sizeChanges: { lines: [{ bundleId: B1.id, toSizeId: S2.id, qty }], reason: 'Counted in long, made as size 2' } })
          await refuses(
            `count-in with more of ${B1.code} made as another size than was counted in is refused whole`,
            () => receiveWithSizes(tx, toStiBlue.id, withSizes(B1.qty + 5), user.id),
            'NOT_ENOUGH_PIECES',
          )
          const still = await tx.processTransfer.findUniqueOrThrow({ where: { id: toStiBlue.id } })
          check('…and nothing of it stands: the card is still on its way, nothing counted in', still.status === 'DISPATCHED' && (await held(STI, B1.id, 'WIP')) === 0)
          await tx.$executeRawUnsafe('SAVEPOINT countin_sizes')
          const out = await receiveWithSizes(tx, toStiBlue.id, withSizes(5), user.id)
          const card1 = await tx.processTransfer.findUniqueOrThrow({ where: { id: toStiBlue.id } })
          const kid = await tx.productionBundle.findFirst({ where: { parentId: B1.id } })
          check(
            `count-in with a size change: the card counted in, and 5 of ${B1.code} made as size ${S2.code} in a new bundle at stitching`,
            card1.status === 'RECEIVED' && out.sizes?.moves?.length === 1 && kid?.sizeId === S2.id && (await held(STI, B1.id, 'WIP')) === B1.qty - 5 && (await held(STI, kid!.id, 'WIP')) === 5,
            { status: card1.status, kid: kid && { size: kid.sizeId, qty: kid.qty } },
          )
          const change = await tx.sizeChange.findFirst({ where: { moId: mo.id, fromBundleId: B1.id }, orderBy: { createdAt: 'desc' } })
          check('…recorded as a size change at stitching, with its reason and who counted in', !!change && change.qty === 5 && change.toSizeId === S2.id)
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT countin_sizes')
        }

        // The blue card is counted in now.
        const blueLines = await tx.processTransferLine.findMany({ where: { transferId: toStiBlue.id } })
        await receive(tx, toStiBlue.id, receiveSchema.parse({ lines: blueLines.map((l) => ({ lineId: l.id, qty: l.dispatchedQty })) }), user.id)

        // ═══ 3 + 4. Several changes in one save, from several bundles and both lays ═══
        const no2 = await lastNo()
        const L2: Line[] = [
          [A2, S2, 5],
          [A10, S2, 5],
          [A11, S1, 5],
        ]
        const s2 = await save(L2, 'Lay 2 marker ran small')
        const kids2 = await tx.productionBundle.findMany({ where: { id: { in: s2.bundleIds } }, orderBy: { bundleNo: 'asc' } })
        const kidOf = (parentId: string) => kids2.find((k) => k.parentId === parentId)
        check(
          '3. one save, three changes (1→2, 3→2, 3→1): one entry, three new bundles numbered on',
          s2.bundleIds.length === 3 &&
            kids2.map((k) => k.bundleNo).join(',') === [no2 + 1, no2 + 2, no2 + 3].join(',') &&
            (await tx.sizeChange.count({ where: { eventId: s2.eventId } })) === 3 &&
            (await tx.wipEvent.count({ where: { moId: mo.id, type: 'SIZE_CHANGE' } })) === 3,
        )
        check(
          '4. one new bundle per old bundle, each made from its own bundle and in its own lay',
          kidOf(A2.id)?.sizeId === S2.id &&
            kidOf(A10.id)?.sizeId === S2.id &&
            kidOf(A11.id)?.sizeId === S1.id &&
            kidOf(A2.id)?.cuttingOrderId === lay1.id &&
            kidOf(A10.id)?.cuttingOrderId === lay1.id &&
            kidOf(A11.id)?.cuttingOrderId === lay2.id &&
            kids2.every((k) => k.qty === 5 && k.splitAtStepId === STI),
          kids2.map((k) => `${k.code} from ${codeOf.get(k.parentId!)}`).join(', '),
        )
        check(
          '4. each old bundle gave 5 from in hand',
          (await held(STI, A2.id, 'WIP')) === 20 && (await held(STI, A10.id, 'WIP')) === 20 && (await held(STI, A11.id, 'WIP')) === 20 && (await Promise.all(s2.bundleIds.map((id) => held(STI, id, 'WIP')))).every((q) => q === 5),
        )
        await checkRevised('3. two saves add up')

        // Two sizes from one bundle in one save; lines naming the same bundle and size are one.
        const L2b: Line[] = [
          [A9, S1, 2],
          [A9, S2, 3],
          [A9, S1, 1],
        ]
        const s2b = await save(L2b, 'Mixed panels in one bundle')
        const kids2b = await tx.productionBundle.findMany({ where: { id: { in: s2b.bundleIds } }, orderBy: { bundleNo: 'asc' } })
        check(
          '3. one bundle into two sizes in one save: two new bundles, the repeated line merged',
          kids2b.length === 2 && kids2b.every((k) => k.parentId === A9.id) && kids2b.find((k) => k.sizeId === S1.id)?.qty === 3 && kids2b.find((k) => k.sizeId === S2.id)?.qty === 3 && (await held(STI, A9.id, 'WIP')) === 19,
          kids2b.map((k) => `${k.code} ${k.qty}`).join(', '),
        )
        await checkRevised('3. three saves add up')

        // ═══ 5. From pieces in hand and from pieces done and waiting ═══
        await recordWork(tx, mo.id, STI, workSchema.parse({ lines: [{ bundleId: A4.id, done: 25 }, { bundleId: A12.id, done: 20 }], personName: 'Line 3' }), user.id)
        const L3: Line[] = [
          [A4, S3, 10],
          [A12, S1, 10],
        ]
        const s3 = await save(L3, 'Made as the other size after stitching')
        const [k4, k12] = await Promise.all([A4, A12].map((p) => tx.productionBundle.findFirstOrThrow({ where: { parentId: p.id, id: { in: s3.bundleIds } } })))
        check(
          `5. from done pieces: ${A4.code}'s 10 go as done (it had none in hand)`,
          (await held(STI, k4.id, 'DONE')) === 10 && (await held(STI, k4.id, 'WIP')) === 0 && (await held(STI, A4.id, 'DONE')) === 15,
        )
        check(
          `5. in hand first, then done: ${A12.code} gives its 5 in hand and 5 done`,
          (await held(STI, k12.id, 'WIP')) === 5 && (await held(STI, k12.id, 'DONE')) === 5 && (await held(STI, A12.id, 'WIP')) === 0 && (await held(STI, A12.id, 'DONE')) === 15,
        )
        await checkRevised('5. revised after changes of done pieces')

        // ═══ 11. Two saves in a row see each other ═══
        const s4 = await save([[A3, S2, 15]], 'First save of the day')
        const err = await refuses(`11. the second save sees the first: ${A3.code} has 10 left, 15 asked`, () => changeSizes(tx, mo.id, input([[A3, S3, 15]], 'Second save of the day'), user.id), 'NOT_ENOUGH_PIECES')
        check('11. the refusal says how many are left', !!err?.message?.includes('10 in hand or done'), err?.message ?? '')
        const s5 = await save([[A3, S3, 10]], 'Second save of the day')
        check(`11. the second save of the 10 left goes through; ${A3.code} is empty at stitching`, (await held(STI, A3.id)) === 0)
        await checkRevised('11. four saves add up')

        // ═══ 7. After part of a bundle went on ═══
        await sendOn(STI, [{ bundleId: A7.id, qty: 10 }])
        const L6: Line[] = [[A7, S3, 10]]
        const s6 = await save(L6, 'Rest of the bundle made as the size up')
        const C6 = s6.bundleIds[0]
        const [dest] = await destinationsOf(tx, { id: mo.id, steps: await tx.mOStep.findMany({ where: { moId: mo.id } }) }, STI)
        check(
          `7. the route takes the new bundle on to finishing: all 10 of it; ${A7.code} 15 more`,
          dest?.step.id === FIN && dest.caps[C6] === 10 && dest.caps[A7.id] === 15,
          dest ? `new ${dest.caps[C6]}, old ${dest.caps[A7.id]}` : 'no destination',
        )
        await sendOn(STI, [{ bundleId: C6, qty: 10 }])
        check('7. the new bundle is counted in at finishing', (await held(FIN, C6, 'WIP')) === 10)
        await refuses('12. undo refused once the new bundle has moved on', () => undoSizeChange(tx, s6.eventId, 'Wrong size after all', user.id), 'NOT_ENOUGH_PIECES')
        check('12. the refused undo leaves the change standing', !(await tx.sizeChange.findFirstOrThrow({ where: { eventId: s6.eventId } })).undoneAt)

        // ═══ 12. Undo through the floor’s general undo ═══
        const L7: Line[] = [[A6, S1, 3]]
        const s7 = await save(L7, 'Three made small')
        await undoEvent(tx, s7.eventId, 'Counted wrong', user.id)
        expect(L7, -1)
        const sc7 = await tx.sizeChange.findFirstOrThrow({ where: { eventId: s7.eventId } })
        check('12. the floor’s undo takes a size change back too', (await held(STI, A6.id, 'WIP')) === 25 && (await held(STI, s7.bundleIds[0])) === 0 && !!sc7.undoneAt && sc7.undoReason === 'Counted wrong')
        await checkRevised('12. revised as before the undone change')

        jc = await card()
        check(
          'stitching by size: the moves in and out add up to every change not undone',
          SIZES.every((z) => sizeFig(jc, z.id, STI).sizeIn === inAt.get(z.id) && sizeFig(jc, z.id, STI).sizeOut === outAt.get(z.id)),
          SIZES.map((z) => `${z.code} +${sizeFig(jc, z.id, STI).sizeIn} −${sizeFig(jc, z.id, STI).sizeOut}`).join('; '),
        )
        check(
          `finishing waits for size 1’s revised ${revisedOf(S1.id)}, not its planned 100; every size its revised count less what came`,
          sizeFig(jc, S1.id, FIN).yetToCome === revisedOf(S1.id) && SIZES.every((z) => sizeFig(jc, z.id, FIN).yetToCome === revisedOf(z.id) - sizeFig(jc, z.id, FIN).received),
          SIZES.map((z) => `${z.code} ${sizeFig(jc, z.id, FIN).yetToCome}`).join('; '),
        )
        check('the sizes add up to the job card: in hand at stitching', SIZES.reduce((s, z) => s + sizeFig(jc, z.id, STI).inHand, 0) === stepFig(jc, STI).inHand)
        check('the job card lists live new bundles, not the undone ones', !jc.bundles.some((b) => b.id === c0 || b.id === s7.bundleIds[0]) && [C1.id, ...s2.bundleIds, C6].every((id) => jc.bundles.some((b) => b.id === id)))

        // ── Everything on to finishing ──
        await sendOn(STI, await readyAt(STI, lineA.id))
        await sendOn(STI, await readyAt(STI, lineB.id))
        await refuses(`12. undo refused once ${C1.code} has gone on to finishing`, () => undoSizeChange(tx, s1.eventId, 'Wrong size after all', user.id), 'NOT_ENOUGH_PIECES')

        // ═══ 9 (on the way). Reconciliation with pieces written off ═══
        const recon = async (label: string) => {
          const os = (await orderSizes(tx, mo.id)).find((l) => l.moLineId === lineA.id)!
          const rows = await tx.wipEntry.groupBy({ by: ['sizeId', 'bucket'], where: { moLineId: lineA.id }, _sum: { qty: true } })
          const parts = SIZES.map((z) => {
            const of = rows.filter((r) => r.sizeId === z.id)
            const sumOf = (buckets: string[]) => of.filter((r) => buckets.includes(r.bucket)).reduce((s, r) => s + (r._sum.qty ?? 0), 0)
            const all = of.reduce((s, r) => s + (r._sum.qty ?? 0), 0)
            const packedFloor = sumOf(['PACKED', 'PACKED_B'])
            const writtenOff = sumOf(['SCRAPPED'])
            const onFloor = all - packedFloor - writtenOff
            const r = os.sizes.find((s) => s.sizeId === z.id)!
            return { code: z.code, revised: r.revised, packed: r.packed, onFloor, writtenOff, ok: r.revised === revisedOf(z.id) && r.revised === r.packed + onFloor + writtenOff && r.packed === packedFloor }
          })
          check(label, parts.every((p) => p.ok), parts.map((p) => `${p.code}: ${p.revised} = ${p.packed} packed + ${p.onFloor} on the floor + ${p.writtenOff} written off`).join('; '))
          return parts
        }
        const dmg = await recordWork(tx, mo.id, FIN, workSchema.parse({ lines: [{ bundleId: C1.id, damaged: 2 }], reason: 'oil stain' }), user.id)
        const off = await decide(tx, mo.id, FIN, decideSchema.parse({ from: 'DAMAGED', to: 'SCRAPPED', lines: [{ bundleId: C1.id, qty: 2 }], reason: 'Stain will not wash out' }), { userId: user.id, mayApprove: true })
        const mid = await recon('9. on the way: each size’s revised count = packed + on the floor + written off')
        check('9. the 2 written off count against size 2, the size they were made as', mid.find((p) => p.code === S2.code)?.writtenOff === 2 && mid.filter((p) => p.code !== S2.code).every((p) => p.writtenOff === 0))
        if ('event' in off && off.event) await undoEvent(tx, off.event.id, 'Washed out after all', user.id)
        if ('event' in dmg && dmg.event) await undoEvent(tx, dmg.event.id, 'Washed out after all', user.id)
        check('9. written off and undone: the 2 are back in hand at finishing', (await held(FIN, C1.id, 'WIP')) === 20)

        // ── Everything on to packing ──
        await sendOn(FIN, await readyAt(FIN, lineA.id))
        await sendOn(FIN, await readyAt(FIN, lineB.id))

        // ═══ 8. Finished goods in the revised sizes ═══
        let os = (await orderSizes(tx, mo.id)).find((l) => l.moLineId === lineA.id)!
        const toPack = (sizeId: string) => os.sizes.find((s) => s.sizeId === sizeId)!.toPack
        check(
          '8. still to pack: each size’s revised count, less the 25 of size 2 packed before',
          SIZES.every((z) => toPack(z.id) === revisedOf(z.id) - (z.id === S2.id ? 25 : 0)),
          SIZES.map((z) => `${z.code} ${toPack(z.id)}`).join('; '),
        )
        await refuses(
          `8. size 1 cannot be packed at its planned 100, only its revised ${revisedOf(S1.id)}`,
          () => createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: [{ itemId: fgA.id, sizeId: S1.id, qty: 100 }] }), user.id),
          'NOT_FINISHED',
        )
        await refuses(
          `8. one more of size 1 than its revised count is refused`,
          () => createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: [{ itemId: fgA.id, sizeId: S1.id, qty: toPack(S1.id) + 1 }] }), user.id),
          'NOT_FINISHED',
        )
        const restLines = SIZES.map((z) => ({ itemId: fgA.id, sizeId: z.id, qty: toPack(z.id) }))
        const r2 = await createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: restLines }), user.id)
        check('8. the rest packed in exactly the revised sizes', r2.lines.length === 3 && SIZES.every((z) => Number(r2.lines.find((l) => l.sizeId === z.id)!.qty) === toPack(z.id)))
        for (const z of SIZES) {
          await refuses(`8. one more of size ${z.code} is refused once all are packed`, () => createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: [{ itemId: fgA.id, sizeId: z.id, qty: 1 }] }), user.id), 'NOT_FINISHED')
        }
        const r1Now = await tx.finishedGoodsReceipt.findUniqueOrThrow({ where: { id: r1.id }, include: { lines: true } })
        const r1Pack = await tx.wipEvent.findFirstOrThrow({ where: { fgReceiptId: r1.id, type: 'PACK' } })
        check(
          '6. the receipt made before the changes is untouched',
          !r1Now.cancelledAt && JSON.stringify(r1Now.lines.map((l) => ({ itemId: l.itemId, sizeId: l.sizeId, qty: Number(l.qty) }))) === r1Lines0 && !r1Pack.reversedAt && (await held(PKG, A8.id, 'PACKED')) === 25,
        )
        await createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: sizesB.map((z) => ({ itemId: fgB.id, sizeId: z.sizeId, qty: z.qty })) }), user.id)

        // ═══ 9. Reconciliation, all packed ═══
        const fgStock = async (sizeId: string) => (await balanceOf(tx, { itemId: fgA.id, warehouseId: store.id, sizeId })).qty
        const parts = await recon('9. all packed: each size’s revised count = packed, nothing on the floor or written off')
        check('9. nothing left on the floor', parts.every((p) => p.onFloor === 0 && p.writtenOff === 0 && p.packed === p.revised))
        check(
          '9. finished-goods stock per size = the revised count',
          (await Promise.all(SIZES.map(async (z) => (await fgStock(z.id)) === revisedOf(z.id)))).every(Boolean),
          (await Promise.all(SIZES.map(async (z) => `${z.code} ${await fgStock(z.id)}`))).join('; '),
        )
        os = (await orderSizes(tx, mo.id)).find((l) => l.moLineId === lineA.id)!
        check('9. nothing left to pack of any size', os.sizes.every((s) => s.toPack === 0 && s.packed === s.revised))
        let moNow = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id } })
        check('9. the order completes when all is packed', moNow.status === 'COMPLETED' && moNow.progress === 'DONE' && moNow.totalPackedQty === 320, `${moNow.status} ${moNow.progress} ${moNow.totalPackedQty}`)
        jc = await card()
        check(
          '9. no size is stuck "yet to come" at finishing or packing; both done',
          [FIN, PKG].every((st) => SIZES.every((z) => sizeFig(jc, z.id, st).yetToCome === 0 && sizeFig(jc, z.id, st).state === 'DONE')),
          [FIN, PKG].map((st) => SIZES.map((z) => `${sizeFig(jc, z.id, st).yetToCome}:${sizeFig(jc, z.id, st).state}`).join('/')).join(' · '),
        )
        check('9. the sales order keeps the buyer’s sizes; the order’s plan is unchanged', (await soSizes()) === soSizes0 && (await moSizes()) === moSizes0 && moNow.totalPlannedQty === 320)

        // ═══ 12. Cancelling a receipt puts the pieces back in the new bundles ═══
        // As POST /finished-goods/:id/cancel does it, inside this transaction.
        const cancelReceipt = async (id: string, reason: string) => {
          await lockRow(tx, 'fgReceipt', id)
          const before = await tx.finishedGoodsReceipt.findUniqueOrThrow({ where: { id } })
          await assertStockUnused(tx, { referenceId: before.id, label: before.fgrNumber })
          const ins = await tx.stockLedger.findMany({ where: { referenceType: 'FG_RECEIPT', referenceId: before.id, inQty: { gt: 0 } } })
          for (const row of ins) {
            await recordMovement(tx, {
              itemId: row.itemId,
              warehouseId: row.warehouseId,
              sizeId: row.sizeId,
              grade: row.grade,
              ownership: row.ownership,
              ownerCustomerId: row.ownerCustomerId,
              transactionType: 'ADJUSTMENT',
              direction: 'OUT',
              qty: Number(row.inQty),
              referenceType: 'FG_RECEIPT_CANCEL',
              referenceId: before.id,
              notes: `Cancelled ${before.fgrNumber}: ${reason}`,
              earlierDate: 'move-up',
            })
          }
          await tx.finishedGoodsReceipt.update({ where: { id: before.id }, data: { cancelledAt: new Date(), cancelledById: user.id, cancelReason: reason } })
          await voidForCancelledReceipt(tx, before.id, `Cancelled ${before.fgrNumber}: ${reason}`, user.id)
          await unpackForReceipt(tx, before.id, `Cancelled ${before.fgrNumber}: ${reason}`, user.id)
          if (before.moId) await syncMoPacked(tx, before.moId)
        }
        await cancelReceipt(r2.id, 'Booked to the wrong store')
        const liveKids = await tx.sizeChange.findMany({ where: { moId: mo.id, undoneAt: null }, select: { toBundleId: true, toBundle: { select: { code: true, qty: true } } } })
        const back = await Promise.all(liveKids.map(async (k) => ({ code: k.toBundle.code, qty: k.toBundle.qty, wip: await held(PKG, k.toBundleId, 'WIP'), packed: await held(PKG, k.toBundleId, 'PACKED') })))
        check(
          '12. cancelling the receipt puts every new bundle’s pieces back in hand at packing',
          back.length === 11 && back.every((k) => k.wip === k.qty && k.packed === 0),
          back.map((k) => `${k.code} ${k.wip}/${k.qty}`).join(', '),
        )
        os = (await orderSizes(tx, mo.id)).find((l) => l.moLineId === lineA.id)!
        moNow = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id } })
        check(
          '12. after the cancel: only the first receipt’s 25 of size 2 still packed; the order reopens',
          os.sizes.every((s) => s.packed === (s.sizeId === S2.id ? 25 : 0)) && (await fgStock(S2.id)) === 25 && (await fgStock(S1.id)) === 0 && moNow.status !== 'COMPLETED' && (await held(PKG, A8.id, 'PACKED')) === 25,
          `${moNow.status}; ${os.sizes.map((s) => `${s.code} ${s.packed}`).join('/')}`,
        )
        await createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: restLines }), user.id)
        moNow = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id } })
        check('12. packed again in the revised sizes, the order completes again', moNow.status === 'COMPLETED' && moNow.progress === 'DONE' && (await Promise.all(SIZES.map(async (z) => (await fgStock(z.id)) === revisedOf(z.id)))).every(Boolean))

        jc = await card()
        check(
          'stitching by size: what came in, plus what was made as it, less what was made as another, all went on',
          SIZES.every((z) => {
            const f = sizeFig(jc, z.id, STI)
            return f.received + f.sizeIn - f.sizeOut === f.sentOn && f.inHand + f.waiting === 0 && f.sentOn === revisedOf(z.id)
          }),
          SIZES.map((z) => {
            const f = sizeFig(jc, z.id, STI)
            return `${z.code}: ${f.received} + ${f.sizeIn} − ${f.sizeOut} = ${f.sentOn}`
          }).join('; '),
        )

        // ═══ History, and the other colour ═══
        const hist = await sizeChangeHistory(tx, { moId: mo.id })
        const saves = [s0, s1, s2, s2b, s3, s4, s5, s6, s7].map((s) => s.eventId)
        check(
          'history: one entry per save, newest first, undone ones marked',
          hist.length === saves.length &&
            saves.every((id) => hist.some((h) => h.eventId === id)) &&
            hist.every((h, i) => i === 0 || hist[i - 1].at.getTime() >= h.at.getTime()) &&
            hist.filter((h) => h.undone).map((h) => h.eventId).sort().join() === [s0.eventId, s7.eventId].sort().join() &&
            hist.find((h) => h.eventId === s2.eventId)!.moves.length === 3,
          `${hist.length} entries`,
        )
        check('the grey job card lists its size changes; the blue one has none', (await card()).sizeChanges.length === saves.length && (await jobCardDetail(tx, cardB.id)).sizeChanges.length === 0)
        const osB = (await orderSizes(tx, mo.id)).find((l) => l.moLineId === lineB.id)!
        check('the blue line’s sizes are untouched and all packed', osB.sizes.every((s) => s.changed === 0 && s.revised === s.planned && s.packed === s.planned))

        // ═══ The ledger: no piece appears or vanishes ═══
        const all = await tx.productionBundle.findMany({ where: { moId: mo.id }, select: { id: true, code: true, qty: true, parentId: true } })
        const sums = new Map((await tx.wipEntry.groupBy({ by: ['bundleId'], where: { moId: mo.id }, _sum: { qty: true } })).map((r) => [r.bundleId, r._sum.qty ?? 0]))
        const kids = new Map<string, string[]>()
        for (const b of all) if (b.parentId) kids.set(b.parentId, [...(kids.get(b.parentId) ?? []), b.id])
        const family = (id: string): number => (sums.get(id) ?? 0) + (kids.get(id) ?? []).reduce((s, k) => s + family(k), 0)
        const originals = all.filter((b) => !b.parentId)
        check(
          'ledger: every bundle as cut, with the bundles made from it, holds exactly what was cut',
          originals.length === 14 && originals.every((b) => family(b.id) === b.qty),
          originals.filter((b) => family(b.id) !== b.qty).map((b) => `${b.code} ${family(b.id)}/${b.qty}`).join(', '),
        )
        const live = new Set(liveKids.map((k) => k.toBundleId))
        const qtyById = new Map(all.map((b) => [b.id, b.qty]))
        check(
          'ledger: a live new bundle holds its pieces, an undone one none, an old one what it did not give',
          all.every((b) => {
            const own = sums.get(b.id) ?? 0
            if (b.parentId) return own === (live.has(b.id) ? b.qty : 0)
            const given = (kids.get(b.id) ?? []).filter((k) => live.has(k)).reduce((s, k) => s + qtyById.get(k)!, 0)
            return own === b.qty - given
          }),
        )

        throw ROLLBACK
      },
      { timeout: 900_000, maxWait: 30_000 },
    )
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  const seriesAfter = JSON.stringify(await prisma.numberSeries.findMany({ select: { docType: true, lastNumber: true }, orderBy: { docType: 'asc' } }))
  check('nothing kept: no number series touched', seriesAfter === seriesBefore)
  check(
    'nothing kept: the test order and items are gone',
    (await prisma.salesOrder.count({ where: { soNumber: `ZZ-SO-${stamp}` } })) === 0 && (await prisma.item.count({ where: { code: { startsWith: `ZZ-FG-${stamp}` } } })) === 0,
  )
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
