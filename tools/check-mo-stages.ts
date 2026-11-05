// Where a manufacturing order stands (its stage, the MO list's Status), end
// to end, on the shared database inside one transaction that always throws:
// a draft; released with nothing asked; a requisition rejected and one closed
// with nothing issued, which ask for nothing; one raised; part issued; every
// material in full; some handed back; given to a cutter; cut; part packed;
// all packed; closed. At each step the stage, and the Status filter finding
// the order at that stage and at no other.
//
// Rolled back: nothing is kept and no number series moves. It needs the demo
// masters (FAB-COT-001, FG-SHRT-001, style LD-SH-2601 with a size run, a
// trim). Run it from apps/api, so the database settings load:
//
//   cd apps/api
//   npx tsx ../../tools/check-mo-stages.ts
import type { Prisma } from '@prisma/client'
import { prisma } from '../packages/database/src/index'
import { createSalesOrderSchema, prepareOrder } from '../apps/api/src/routes/sales.routes'
import { createMo, createMoSchema, releaseMo } from '../apps/api/src/routes/production.routes'
import { MO_STAGES, moStages, stageWhere, type MoStage } from '../apps/api/src/services/manufacturing.service'

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
  const trim = await prisma.item.findFirst({ where: { isActive: true, type: 'TRIM' }, orderBy: { code: 'asc' } })
  const fgTemplate = await prisma.item.findUnique({ where: { code: 'FG-SHRT-001' } })
  const store = await prisma.warehouse.findFirst({ where: { isActive: true }, select: { id: true } })
  const user = await prisma.user.findFirst({ select: { id: true } })
  const style = await prisma.style.findUnique({ where: { code: 'LD-SH-2601' }, include: { sizeGroup: { include: { sizes: true } } } })
  const dept = await prisma.department.findFirst({ where: { name: 'Cutting' } })
  if (!cust || !brand || !fabric || !trim || !fgTemplate || !store || !user || !style?.sizeGroup || !dept) throw new Error('test data missing')
  const [S1, S2] = [...style.sizeGroup.sizes].sort((a, b) => a.sequence - b.sequence)
  const seriesBefore = JSON.stringify(await prisma.numberSeries.findMany({ select: { docType: true, lastNumber: true }, orderBy: { docType: 'asc' } }))

  try {
    await prisma.$transaction(
      async (tx) => {
        // ── A shirt in a colour of its own, with a BOM: 1.5 m of fabric and 8 trims a piece ──
        const color = `ZZ Stage ${stamp}`
        await tx.style.update({ where: { id: style.id }, data: { colors: { push: color } } })
        const taxRateId = fgTemplate.taxRateId ?? (await tx.taxRate.findFirstOrThrow({ where: { rate: 5 } })).id
        const fg = await tx.item.create({
          data: { code: `ZZ-FG-${stamp}`, name: 'Test shirt', type: 'FINISHED_GOOD', categoryId: fgTemplate.categoryId, uomId: fgTemplate.uomId, styleId: style.id, color, standardRate: 250, hsnCode: fgTemplate.hsnCode ?? '6205', taxRateId },
        })
        await tx.bOM.create({
          data: {
            styleId: style.id,
            color,
            version: '1.0',
            status: 'APPROVED',
            approvedAt: new Date(),
            lines: {
              create: [
                { componentItemId: fabric.id, qtyPerUnit: 1.5, wastagePercent: 0, effectiveQty: 1.5, sortOrder: 0 },
                { componentItemId: trim.id, qtyPerUnit: 8, wastagePercent: 0, effectiveQty: 8, sortOrder: 1 },
              ],
            },
          },
        })
        const { header, lines } = await prepareOrder(
          tx,
          createSalesOrderSchema.parse({ customerId: cust.id, brandId: brand.id, lines: [{ itemId: fg.id, color, totalQty: 20, unitPrice: 300, sizes: [{ sizeId: S1.id, qty: 10 }, { sizeId: S2.id, qty: 10 }] }] }),
        )
        const so = await tx.salesOrder.create({ data: { ...header, soNumber: `ZZ-SO-${stamp}`, status: 'CONFIRMED', createdById: user.id, lines: { create: lines } }, include: { lines: true } })

        // The stage, and the filter: the order turns up under its stage and no other.
        const stageIs = async (label: string, want: MoStage, items?: [number, number]) => {
          const row = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id }, select: { id: true, status: true, totalCutQty: true, totalPackedQty: true } })
          const got = (await moStages(tx, [row])).get(mo.id)
          const found: string[] = []
          for (const s of MO_STAGES) {
            const where: Prisma.ManufacturingOrderWhereInput = { AND: [{ id: mo.id }, await stageWhere(tx, s, { id: mo.id })] }
            if (await tx.manufacturingOrder.count({ where })) found.push(s)
          }
          const counts = items ? got?.materialItemsInFull === items[0] && got?.materialItems === items[1] : true
          check(
            `${label}: ${want}${items ? ` (${items[0]} of ${items[1]} in full)` : ''}`,
            got?.stage === want && counts && found.length === 1 && found[0] === want,
            `stage ${got?.stage} items ${got?.materialItemsInFull}/${got?.materialItems}; the filter finds it under ${found.join(', ') || 'nothing'}`,
          )
        }

        // ── Draft, then released ──
        const mo = await createMo(tx, createMoSchema.parse({ soId: so.id, lines: [{ soLineId: so.lines[0].id, sizes: [{ sizeId: S1.id, qty: 10 }, { sizeId: S2.id, qty: 10 }] }] }), user.id)
        await stageIs('a draft', 'DRAFT')
        await releaseMo(tx, mo.id)
        await stageIs('released, nothing asked of the store', 'NOT_ASKED')

        // ── Requisitions that ask for nothing: rejected, or closed with nothing issued ──
        const mr = (n: string, data: Partial<Prisma.MaterialRequisitionUncheckedCreateInput>, lines: Array<{ itemId: string; requestedQty: number; issuedQty?: number }>) =>
          tx.materialRequisition.create({
            data: { mrNumber: `ZZ-MR-${stamp}-${n}`, moId: mo.id, departmentId: dept.id, ...data, lines: { create: lines.map((l) => ({ ...l, warehouseId: store.id })) } },
            include: { lines: true },
          })
        await mr('R', { status: 'REJECTED' }, [{ itemId: fabric.id, requestedQty: 30 }])
        await stageIs('a rejected requisition asks for nothing', 'NOT_ASKED')
        await mr('C', { status: 'APPROVED', closedAt: new Date(), closeReason: 'Not needed' }, [{ itemId: fabric.id, requestedQty: 30 }])
        await stageIs('nor does one closed with nothing issued', 'NOT_ASKED')

        // ── Asked, part issued, in full, some handed back ──
        const ask = await mr('A', { status: 'PENDING' }, [
          { itemId: fabric.id, requestedQty: 30 },
          { itemId: trim.id, requestedQty: 160 },
        ])
        await stageIs('a requisition raised, waiting for approval', 'ASKED')
        await tx.materialRequisition.update({ where: { id: ask.id }, data: { status: 'APPROVED' } })
        await stageIs('approved, nothing issued yet', 'ASKED')
        const [fabLine, trimLine] = [ask.lines.find((l) => l.itemId === fabric.id)!, ask.lines.find((l) => l.itemId === trim.id)!]
        await tx.materialRequisitionLine.update({ where: { id: fabLine.id }, data: { issuedQty: 30 } })
        await tx.materialRequisitionLine.update({ where: { id: trimLine.id }, data: { issuedQty: 100 } })
        await stageIs('the fabric issued in full, 100 of 160 trims', 'PART_ISSUED', [1, 2])
        await tx.materialRequisitionLine.update({ where: { id: trimLine.id }, data: { issuedQty: 160 } })
        await stageIs('every material issued in full', 'ISSUED', [2, 2])
        await tx.materialRequisitionLine.update({ where: { id: fabLine.id }, data: { returnedQty: 2 } })
        await stageIs('2 m of the fabric handed back: no longer in full', 'PART_ISSUED', [1, 2])
        await tx.materialRequisitionLine.update({ where: { id: fabLine.id }, data: { returnedQty: 0 } })

        // ── Cutting, packing, the end ──
        const cutting = await tx.cuttingOrder.create({ data: { cutOrderNumber: `ZZ-CUT-${stamp}`, moId: mo.id, plannedPieces: 20, status: 'CANCELLED' } })
        await stageIs('a cutting sheet cancelled does not count', 'ISSUED', [2, 2])
        await tx.cuttingOrder.update({ where: { id: cutting.id }, data: { status: 'IN_PROGRESS' } })
        await stageIs('given to a cutter, nothing cut yet', 'IN_PRODUCTION')
        await tx.cuttingOrder.update({ where: { id: cutting.id }, data: { status: 'COMPLETED', actualPieces: 20 } })
        await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { totalCutQty: 20 } })
        await stageIs('20 cut', 'IN_PRODUCTION')
        await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { totalPackedQty: 8 } })
        await stageIs('8 of 20 packed', 'PACKING')
        await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { totalPackedQty: 20, status: 'COMPLETED' } })
        await stageIs('all 20 packed', 'COMPLETED')
        await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { status: 'CLOSED' } })
        await stageIs('closed', 'CLOSED')

        throw ROLLBACK
      },
      { timeout: 120_000 },
    )
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  const seriesAfter = JSON.stringify(await prisma.numberSeries.findMany({ select: { docType: true, lastNumber: true }, orderBy: { docType: 'asc' } }))
  check('rolled back: no number series moved', seriesBefore === seriesAfter)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
