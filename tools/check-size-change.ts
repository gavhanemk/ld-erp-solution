// Size jumps at stitching, end to end, inside one transaction that always
// throws (nothing is kept): pieces of a bundle cut as one size made as another
// size of the order line at stitching on our own floor. Since 12 Nov 2026 the
// pieces change size inside their own bundle — no bundle is made, so the
// bundle count and the cutting stickers stay as cut — and a bundle can hold two
// sizes from then on; the order's planned sizes and the sales order are never
// edited; finished goods are taken by the size the pieces are now; a change
// can be undone while its pieces have not moved on.
//
// Covers: no change; a change undone; two sizes swapped both ways in one save;
// one size to another inside the bundle (ledger, rows, revised sizes,
// duplicates); pieces changing size only once and every refusal; a whole
// bundle becoming the new size (its sticker printed again); a count-in with a
// size change; a bundle holding two sizes sent on whole and in part; undo
// refused and done; finished goods by the size the pieces are now, refused,
// and a receipt cancelled; and the ledger adding up for every bundle and size.
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
        check('12. the job card totals do not move with a size change', totalsOf(await card()) === totals0)
        await undoSizeChange(tx, s0.eventId, 'Measured again: they were right', user.id)
        expect(L0, -1)
        const sc0 = await tx.sizeChange.findFirstOrThrow({ where: { eventId: s0.eventId } })
        const a5 = await tx.wipEntry.groupBy({ by: ['sizeId'], where: { bundleId: A5.id, stepId: STI, bucket: 'WIP' }, _sum: { qty: true } })
        check(
          '12. undone: A5 holds its 25, all of size 2 again',
          (await held(STI, A5.id, 'WIP')) === 25 && (a5.find((r) => r.sizeId === S2.id)?._sum.qty ?? 0) === 25 && (a5.find((r) => r.sizeId === S3.id)?._sum.qty ?? 0) === 0,
        )
        check(
          '12. the change stays on record as undone, with who and why',
          !!sc0.undoneAt && sc0.undoneById === user.id && sc0.undoReason === 'Measured again: they were right' && !!(await tx.wipEvent.findUniqueOrThrow({ where: { id: s0.eventId } })).reversedAt,
        )
        await checkRevised('12. undone: every size is back to its planned count')
        jc = await card()
        check('12. no bundle was made: the job card lists its 12 bundles as cut; totals as before', jc.bundles.length === 12 && totalsOf(jc) === totals0, `${jc.bundles.length} bundles`)
        await refuses('12. a size change is undone only once', () => undoSizeChange(tx, s0.eventId, 'twice over', user.id), 'ALREADY_UNDONE')

        // Since 12 Nov 2026 a size change makes no bundle: the pieces change size inside their own
        // bundle, on the ledger, where they lie. These read a bundle's pieces size by size.
        const bundleCount = () => tx.productionBundle.count({ where: { moId: mo.id } })
        const sizesAt = async (stepId: string, bundleId: string) => {
          const rows = await tx.wipEntry.groupBy({ by: ['sizeId'], where: { bundleId, stepId, vendorId: null, bucket: { in: ['WIP', 'DONE'] } }, _sum: { qty: true } })
          const m = new Map(rows.map((r) => [r.sizeId, r._sum.qty ?? 0]))
          return (z: { id: string }) => m.get(z.id) ?? 0
        }

        // ═══ The floor's swap, in one save: 20 of size 1 made as size 2 and 25 of size 2 made as
        // size 1, from five bundles — inside those five bundles. Tried, then rolled back. ═══
        await tx.$executeRawUnsafe('SAVEPOINT swap')
        {
          const count0 = await bundleCount()
          const sw = await changeSizes(
            tx,
            mo.id,
            input([[A1, S2, 10], [A2, S2, 10], [A5, S1, 10], [A6, S1, 10], [A7, S1, 5]], 'Size 1 measured as size 2, and size 2 as size 1'),
            user.id,
          )
          const rows = await tx.sizeChange.findMany({ where: { eventId: sw.eventId } })
          check(
            'swap: one save, five size-change rows, all inside their own bundles; no bundle made; none wholly changed',
            rows.length === 5 && rows.every((r) => r.toBundleId === null) && (await bundleCount()) === count0 && sw.bundleIds.length === 0,
            `${await bundleCount()} bundles`,
          )
          const [a1, a7] = await Promise.all([sizesAt(STI, A1.id), sizesAt(STI, A7.id)])
          const kept = await Promise.all([A1, A2, A5, A6, A7].map((b) => held(STI, b.id, 'WIP')))
          check(
            'swap: every bundle still holds its 25; A1 is 15 of size 1 and 10 of size 2, A7 20 of size 2 and 5 of size 1',
            kept.every((q) => q === 25) && a1(S1) === 15 && a1(S2) === 10 && a7(S2) === 20 && a7(S1) === 5,
            `held ${kept.join('/')}; A1 ${a1(S1)}+${a1(S2)}; A7 ${a7(S2)}+${a7(S1)}`,
          )
          const os = (await orderSizes(tx, mo.id)).find((l) => l.moLineId === lineA.id)!
          const rev = (z: { id: string }) => os.sizes.find((s) => s.sizeId === z.id)!.revised
          const swapCard = await card()
          check('swap: size 1 = 105, size 2 = 95, size 3 untouched', rev(S1) === 105 && rev(S2) === 95 && rev(S3) === 100, `${rev(S1)}/${rev(S2)}/${rev(S3)}`)
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

        // ═══ 2. One size to another, inside the bundle: 20 of A1 (size 1) made as size 2 ═══
        const count0 = await bundleCount()
        const k1 = `k-size-1-${stamp}`
        const L1: Line[] = [[A1, S2, 20]]
        const s1 = await save(L1, 'Panels cut large, made as the next size', { clientKey: k1, personName: 'Line 3' })
        check('2. no bundle is made: the count stays as cut, and nothing to print again', (await bundleCount()) === count0 && s1.bundleIds.length === 0, `${await bundleCount()} bundles`)
        const sc1 = await tx.sizeChange.findMany({ where: { eventId: s1.eventId } })
        check(
          '2. one size-change row: from A1 and size 1, to size 2 in the same bundle, pieces, reason, who',
          sc1.length === 1 &&
            sc1[0].fromBundleId === A1.id &&
            sc1[0].toBundleId === null &&
            sc1[0].fromSizeId === S1.id &&
            sc1[0].toSizeId === S2.id &&
            sc1[0].qty === 20 &&
            sc1[0].stepId === STI &&
            sc1[0].reason === 'Panels cut large, made as the next size' &&
            sc1[0].createdById === user.id,
        )
        const ev1 = await tx.wipEvent.findUniqueOrThrow({ where: { id: s1.eventId }, include: { entries: true } })
        check(
          '2. on the ledger: A1 at stitching gives 20 of size 1 and takes 20 of size 2 — no piece moves',
          ev1.entries.length === 2 &&
            ev1.entries.every((e) => e.bundleId === A1.id && e.stepId === STI && e.bucket === 'WIP') &&
            ev1.entries.some((e) => e.sizeId === S1.id && e.qty === -20) &&
            ev1.entries.some((e) => e.sizeId === S2.id && e.qty === 20),
          ev1.entries.map((e) => `${e.qty}`).join(' '),
        )
        const a1 = await sizesAt(STI, A1.id)
        check('2. A1 holds its 25 at stitching: 5 of size 1, 20 of size 2', (await held(STI, A1.id)) === 25 && a1(S1) === 5 && a1(S2) === 20, `${a1(S1)} + ${a1(S2)}`)
        await checkRevised('2. revised: size 1 −20, size 2 +20')
        const again = await changeSizes(tx, mo.id, input(L1, 'Panels cut large, made as the next size', { clientKey: k1 }), user.id)
        check('2. the same save sent twice is kept once', again.duplicate === true && (await tx.sizeChange.count({ where: { fromBundleId: A1.id } })) === 1)

        // ═══ 3. Pieces change size once: only A1's 5 still of size 1 can change ═══
        await refuses('3. 6 more of A1 is more than its 5 still of size 1', () => changeSizes(tx, mo.id, input([[A1, S3, 6]], 'Again'), user.id), 'NOT_ENOUGH_PIECES')
        await refuses('3. not to the size it was cut in', () => changeSizes(tx, mo.id, input([[A5, S2, 3]], 'Same size'), user.id), 'SAME_SIZE')
        await refuses('3. only to a size on the order line', () => changeSizes(tx, mo.id, input([[A5, S4, 3]], 'Not on the order'), user.id), 'NOT_ON_ORDER')
        await refuses('3. only at stitching', () => changeSizes(tx, mo.id, input([[A5, S1, 3]], 'At finishing', { stepId: FIN }), user.id), 'NOT_AT_STITCHING')

        // ═══ 4. A whole bundle: all 25 of A2 (size 1) made as size 2 — the same bundle, wholly size 2 now ═══
        const s4 = await save([[A2, S2, 25]], 'The whole bundle measured as size 2')
        const a2 = await sizesAt(STI, A2.id)
        check(
          '4. a whole bundle: no bundle made, A2 is wholly size 2 now, and its sticker is to be printed again',
          (await bundleCount()) === count0 && a2(S1) === 0 && a2(S2) === 25 && s4.bundleIds.length === 1 && s4.bundleIds[0] === A2.id,
          `${a2(S1)} + ${a2(S2)}; reprint ${s4.bundleIds.length}`,
        )
        await checkRevised('4. revised: size 1 −45, size 2 +45 in all')

        // ═══ 5. Counted in at stitching with a size change: the blue card, 4 of B1 made as size 2 ═══
        const blueLines = await tx.processTransferLine.findMany({ where: { transferId: toStiBlue.id } })
        const r5 = await receiveWithSizes(
          tx,
          toStiBlue.id,
          receiveSchema.parse({
            lines: blueLines.map((l) => ({ lineId: l.id, qty: l.dispatchedQty })),
            sizeChanges: { lines: [{ bundleId: B1.id, toSizeId: S2.id, qty: 4 }], reason: 'Counted in: 4 made as size 2' },
            // 2 of B2 arrived damaged: counted in and put among the damaged in the same save.
            damaged: { lines: [{ bundleId: B2.id, qty: 2 }], reason: 'Arrived torn' },
          }),
          user.id,
        )
        const b1 = await sizesAt(STI, B1.id)
        check(
          '5. counted in with a size change: B1 holds its 10, 6 of size 1 and 4 of size 2; no bundle made',
          !!r5.sizes && (await held(STI, B1.id)) === 10 && b1(S1) === 6 && b1(S2) === 4 && (await bundleCount()) === count0,
          `${b1(S1)} + ${b1(S2)}`,
        )

        const b2 = await tx.wipEntry.groupBy({ by: ['bucket'], where: { bundleId: B2.id, stepId: STI }, _sum: { qty: true } })
        const b2In = (bucket: string) => b2.find((r) => r.bucket === bucket)?._sum.qty ?? 0
        const hurt = await tx.wipEvent.findFirst({ where: { moId: mo.id, type: 'PROCESS', stepId: STI, reason: 'Arrived torn' }, include: { entries: true } })
        check(
          '5. arrived damaged: B2 counted in whole (10), 8 in hand and 2 among the damaged at stitching, with the reason; waits for a decision',
          r5.damaged === 2 && b2In('WIP') === 8 && b2In('DAMAGED') === 2 && !!hurt && hurt.entries.some((e) => e.bundleId === B2.id && e.bucket === 'DAMAGED' && e.qty === 2),
          `in hand ${b2In('WIP')}, damaged ${b2In('DAMAGED')}`,
        )

        // ═══ 6. A bundle holding two sizes goes on: each size goes with it, exactly ═══
        await sendOn(STI, [{ bundleId: A1.id, qty: 25 }])
        const a1f = await sizesAt(FIN, A1.id)
        check('6. A1 sent on whole: at finishing 5 of size 1 and 20 of size 2', a1f(S1) === 5 && a1f(S2) === 20 && (await held(STI, A1.id)) === 0, `${a1f(S1)} + ${a1f(S2)}`)
        // Part of one: 10 of A9 (size 3) made as size 1, then 15 of A9 sent on — shared out by what each size has.
        const s6 = await save([[A9, S1, 10]], 'Ten of A9 made as size 1')
        await sendOn(STI, [{ bundleId: A9.id, qty: 15 }])
        const [a9s, a9f] = await Promise.all([sizesAt(STI, A9.id), sizesAt(FIN, A9.id)])
        check(
          '6. 15 of A9 (15 of size 3, 10 of size 1) sent on: 9 of size 3 and 6 of size 1 go, 6 and 4 stay — never more of a size than there is',
          a9f(S3) === 9 && a9f(S1) === 6 && a9s(S3) === 6 && a9s(S1) === 4,
          `went ${a9f(S3)}+${a9f(S1)}, stayed ${a9s(S3)}+${a9s(S1)}`,
        )
        jc = await card()
        check(
          '6. finishing receives each size as it is made: size 1 5 + 6, size 2 20 (and 25 earlier), size 3 9',
          sizeFig(jc, S1.id, FIN).received === 11 && sizeFig(jc, S2.id, FIN).received === 45 && sizeFig(jc, S3.id, FIN).received === 9,
          SIZES.map((z) => sizeFig(jc, z.id, FIN).received).join('/'),
        )

        // ═══ 7. Undo: refused once the pieces have moved on, done while they are still there ═══
        await refuses('7. A9’s change cannot be undone: some of its size-1 pieces have gone on', () => undoSizeChange(tx, s6.eventId, 'Measured again', user.id), 'NOT_ENOUGH_PIECES')
        const blueChange = await tx.sizeChange.findFirstOrThrow({ where: { fromBundleId: B1.id } })
        await undoSizeChange(tx, blueChange.eventId, 'Counted wrong', user.id)
        const b1u = await sizesAt(STI, B1.id)
        check('7. B1’s change undone: all 10 of size 1 again, the row kept as undone', b1u(S1) === 10 && b1u(S2) === 0 && !!(await tx.sizeChange.findUniqueOrThrow({ where: { id: blueChange.id } })).undoneAt)

        // ═══ 8. Finished goods by the size the pieces are now ═══
        await sendOn(FIN, [{ bundleId: A1.id, qty: 25 }])
        const r8 = await createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: [{ itemId: fgA.id, sizeId: S2.id, qty: 20 }] }), user.id)
        const packed = await tx.wipEntry.findMany({ where: { event: { fgReceiptId: r8.id, type: 'PACK' }, bucket: 'PACKED' } })
        check(
          '8. 20 of size 2 booked in: taken from A1 (cut as size 1), packed as size 2',
          packed.length === 1 && packed[0].bundleId === A1.id && packed[0].sizeId === S2.id && packed[0].qty === 20 && (await balanceOf(tx, { itemId: fgA.id, warehouseId: store.id, sizeId: S2.id })).qty === 45,
          packed.map((e) => `${codeOf.get(e.bundleId)} ${e.qty}`).join(', '),
        )
        await refuses(
          '8. size 1 booked in finds only A1’s 5 of size 1 at packing: 6 is more than has reached it',
          () => createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: [{ itemId: fgA.id, sizeId: S1.id, qty: 6 }] }), user.id),
          'NOT_FINISHED',
        )
        const r8b = await createFgReceipt(tx, fgSchema.parse({ warehouseId: store.id, moId: mo.id, lines: [{ itemId: fgA.id, sizeId: S1.id, qty: 5 }] }), user.id)
        const packedB = await tx.wipEntry.findMany({ where: { event: { fgReceiptId: r8b.id, type: 'PACK' }, bucket: 'PACKED' } })
        const os8 = (await orderSizes(tx, mo.id)).find((l) => l.moLineId === lineA.id)!
        check(
          '8. the 5 of size 1 from A1 booked in as size 1; the order counts size 2 packed 45, size 1 5',
          packedB.length === 1 && packedB[0].bundleId === A1.id && packedB[0].sizeId === S1.id && os8.sizes.find((s) => s.sizeId === S2.id)!.packed === 45 && os8.sizes.find((s) => s.sizeId === S1.id)!.packed === 5,
        )
        // Cancelling a receipt puts its pieces back in the size they were packed as.
        await unpackForReceipt(tx, r8.id, 'Booked by mistake', user.id)
        const a1p = await sizesAt(PKG, A1.id)
        check('8. a cancelled receipt puts the 20 back at packing as size 2', a1p(S2) === 20 && a1p(S1) === 0, `${a1p(S2)} + ${a1p(S1)}`)

        // ═══ Ledger: every bundle holds exactly what was cut, and no size of any bundle anywhere is below nothing ═══
        const sums = await tx.wipEntry.groupBy({ by: ['bundleId'], where: { moId: mo.id }, _sum: { qty: true } })
        const qtyOf = new Map(cutBundles.map((b) => [b.id, b.qty]))
        check(
          'ledger: still 14 bundles, each holding exactly what was cut',
          (await bundleCount()) === 14 && sums.length === 14 && sums.every((r) => (r._sum.qty ?? 0) === qtyOf.get(r.bundleId)),
          sums.filter((r) => (r._sum.qty ?? 0) !== qtyOf.get(r.bundleId)).map((r) => `${codeOf.get(r.bundleId)} ${r._sum.qty}`).join(', '),
        )
        const bySize = await tx.wipEntry.groupBy({ by: ['stepId', 'vendorId', 'bucket', 'bundleId', 'reworkStepId', 'sizeId'], where: { moId: mo.id }, _sum: { qty: true } })
        check('ledger: no size of any bundle at any place is below nothing', bySize.every((r) => (r._sum.qty ?? 0) >= 0), `${bySize.filter((r) => (r._sum.qty ?? 0) < 0).length} below`)
        check('the order and the sales order keep their planned sizes', (await moSizes()) === moSizes0 && (await soSizes()) === soSizes0)

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
