/**
 * Tagged garments on stock transfers: the stock ledger and each piece's tag
 * move together, direct or in transit.
 *
 *   - a typed transfer may move untagged pieces without naming tags, and must
 *     name tags beyond what the store holds untagged; named tags must be this
 *     line's item, size, grade and owner, in this store, free to move;
 *   - the named tags arrive with the stock; a direct transfer cancelled walks
 *     its tags back;
 *   - in transit: tags wait on the road; a partial receipt names its tags;
 *     damaged pieces' tags are held as R; tags sent back return; lost ones are
 *     written off; a cancellation brings every tag back;
 *   - a scanned move passes its tags through the same transfer, recorded once;
 *   - Stock Reconciliation finds no tag claiming more than a store holds.
 *
 * Inside one transaction that always throws: nothing is kept. Demo database
 * (lderp_demo) only, needing style LD-SH-2601 with its size run and FG-SHRT-001.
 * From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   npx tsx ../../tools/check-garment-tag-transfers.ts
 */
import { prisma } from '../packages/database/src/index'
import { createSalesOrderSchema, prepareOrder } from '../apps/api/src/routes/sales.routes'
import { createMo, createMoSchema } from '../apps/api/src/routes/production.routes'
import { createFgReceipt, createSchema as fgSchema } from '../apps/api/src/routes/finishedGoods.routes'
import { cancelTransfer, createTransfer } from '../apps/api/src/routes/inventory.routes'
import { generateGarments } from '../apps/api/src/services/garment.service'
import { moveGarments } from '../apps/api/src/services/garmentMove.service'
import { cancelInTransit, receiveTransfer, sendBackTransfer, writeOffTransfer } from '../apps/api/src/services/transitTransfer.service'
import { balanceOf } from '../apps/api/src/services/stock.service'
import { stockReconciliation } from '../apps/api/src/reports/definitions/stock-reconciliation'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 600)}` : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')
const stamp = Date.now().toString(36).slice(-5).toUpperCase()

async function main() {
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== 'lderp_demo') {
    console.error('Refusing to run: not lderp_demo.')
    process.exitCode = 2
    return
  }
  const cust = await prisma.customer.findFirst({ where: { isActive: true, isBlacklisted: false, OR: [{ shippingStateCode: { not: null } }, { billingStateCode: { not: null } }] }, select: { id: true } })
  const brand = await prisma.brand.findFirst({ where: { isActive: true, isDefault: true } })
  const fgTemplate = await prisma.item.findUnique({ where: { code: 'FG-SHRT-001' } })
  const user = await prisma.user.findFirst({ where: { role: { name: { in: ['Super Admin', 'Admin'] } } }, select: { id: true } })
  const style = await prisma.style.findUnique({ where: { code: 'LD-SH-2601' }, include: { sizeGroup: { include: { sizes: true } } } })
  const company = await prisma.warehouse.findFirst({ select: { companyId: true } })
  if (!cust || !brand || !fgTemplate || !user || !style?.sizeGroup || !company) throw new Error('demo masters missing')
  const [S1, S2] = [...style.sizeGroup.sizes].sort((a, b) => a.sequence - b.sequence)

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
        const store = (name: string, kind: 'FINISHED_GOODS' | 'TRANSIT') =>
          tx.warehouse.create({ data: { name, code: `ZZTG-${kind.slice(0, 2)}-${name.slice(-1)}-${stamp}`, kind, companyId: company.companyId }, select: { id: true, name: true } })
        const A = await store(`ZZTEST TG Store A`, 'FINISHED_GOODS')
        const B = await store(`ZZTEST TG Store B`, 'FINISHED_GOODS')
        // The only transit store for this run.
        await tx.warehouse.updateMany({ where: { kind: 'TRANSIT' }, data: { isActive: false } })
        const T = await store(`ZZTEST TG Transit T`, 'TRANSIT')

        const color = `ZZ TG ${stamp}`
        await tx.style.update({ where: { id: style.id }, data: { colors: { push: color } } })
        const taxRateId = fgTemplate.taxRateId ?? (await tx.taxRate.findFirstOrThrow({ where: { rate: 5 } })).id
        const fg = await tx.item.create({
          data: { code: `ZZTGG${stamp}`, name: `ZZTEST TG shirt ${stamp}`, type: 'FINISHED_GOOD', categoryId: fgTemplate.categoryId, uomId: fgTemplate.uomId, styleId: style.id, color, standardRate: 250, hsnCode: fgTemplate.hsnCode ?? '6205', taxRateId },
          select: { id: true },
        })
        const { header, lines } = await prepareOrder(
          tx,
          createSalesOrderSchema.parse({ customerId: cust.id, brandId: brand.id, customerPORef: `ZZTG-${stamp}`, lines: [{ itemId: fg.id, color, totalQty: 60, unitPrice: 400, sizes: [{ sizeId: S1.id, qty: 30 }, { sizeId: S2.id, qty: 30 }] }] }),
        )
        const so = await tx.salesOrder.create({ data: { ...header, soNumber: `ZZ-TGSO-${stamp}`, status: 'CONFIRMED', createdById: user.id, lines: { create: lines } }, include: { lines: true } })
        const mo = await createMo(tx, createMoSchema.parse({ soId: so.id, release: true, lines: [{ soLineId: so.lines[0].id, sizes: [{ sizeId: S1.id, qty: 30 }, { sizeId: S2.id, qty: 30 }] }] }), user.id)
        await createFgReceipt(tx, fgSchema.parse({ warehouseId: A.id, moId: mo.id, lines: [{ itemId: fg.id, sizeId: S1.id, qty: 20 }, { itemId: fg.id, sizeId: S2.id, qty: 10 }] }), user.id)
        await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { tagGarments: true } })
        const made = await generateGarments(tx, mo.id, {}, user.id)
        // Five more of size 1 come in afterwards, untagged.
        await createFgReceipt(tx, fgSchema.parse({ warehouseId: A.id, moId: mo.id, lines: [{ itemId: fg.id, sizeId: S1.id, qty: 5 }] }), user.id)
        const key = (sizeId: string, grade = 'A') => ({ itemId: fg.id, sizeId, grade, ownership: 'OWNED' as const, ownerCustomerId: null })
        const tags = (warehouseId: string, sizeId: string, grade = 'A', status: 'IN_STOCK' | 'SCRAPPED' = 'IN_STOCK') =>
          tx.garment.findMany({ where: { ...key(sizeId, grade), warehouseId, status }, select: { id: true, code: true }, orderBy: { code: 'asc' } })
        const held = async (warehouseId: string, sizeId: string, grade = 'A') => (await balanceOf(tx, { itemId: fg.id, warehouseId, sizeId, grade })).qty
        check('setup: 30 pieces tagged (20 of size 1, 10 of size 2), then 5 of size 1 untagged', made.created === 30 && (await held(A.id, S1.id)) === 25 && (await tags(A.id, S1.id)).length === 20, [made.created, await held(A.id, S1.id)])

        // ── Direct, typed ──
        const move = (lines: Array<{ sizeId: string; qty: number; codes?: string[]; grade?: 'A' | 'B' | 'R' }>, mode?: 'IN_TRANSIT') =>
          createTransfer(
            tx,
            { fromWarehouseId: A.id, toWarehouseId: B.id, ...(mode ? { mode } : {}), lines: lines.map((l) => ({ itemId: fg.id, qty: l.qty, sizeId: l.sizeId, grade: l.grade ?? 'A', ...(l.codes ? { garmentCodes: l.codes } : {}) })) } as never,
            user.id,
          )
        const t1 = await move([{ sizeId: S1.id, qty: 3 }])
        check('3 untagged pieces move without a tag named; no tag moves', !!t1 && (await held(B.id, S1.id)) === 3 && (await tags(B.id, S1.id)).length === 0 && (await tags(A.id, S1.id)).length === 20)
        await refuses('5 more without tags is refused: only 2 untagged are left, so 3 must be named', () => move([{ sizeId: S1.id, qty: 5 }]), 'TAGS_NEEDED')
        const s2codes = (await tags(A.id, S2.id)).map((g) => g.code)
        await refuses('a tag of another size is refused on the line', () => move([{ sizeId: S1.id, qty: 5, codes: s2codes.slice(0, 3) }]), 'WRONG_TAG')
        const s1codes = (await tags(A.id, S1.id)).map((g) => g.code)
        const t2 = await move([{ sizeId: S1.id, qty: 5, codes: s1codes.slice(0, 3) }])
        check('5 with 3 tags named: the 3 tags arrive with the stock', (await held(B.id, S1.id)) === 8 && (await tags(B.id, S1.id)).length === 3 && (await tags(A.id, S1.id)).length === 17, [await held(B.id, S1.id), (await tags(B.id, S1.id)).length])
        await refuses('a tag already moved cannot move again from the old store', () => move([{ sizeId: S1.id, qty: 1, codes: s1codes.slice(0, 1) }]), 'WRONG_TAG')
        const ev = await tx.garmentEvent.count({ where: { referenceId: t2.id, type: 'TRANSFERRED' } })
        check('each moved tag has one TRANSFERRED event naming the transfer', ev === 3, ev)
        // Cancelled: its tags walk back with the stock — unless one has moved on.
        const t2b = await move([{ sizeId: S1.id, qty: 2, codes: s1codes.slice(3, 5) }])
        await createTransfer(tx, { fromWarehouseId: B.id, toWarehouseId: A.id, lines: [{ itemId: fg.id, qty: 1, sizeId: S1.id, grade: 'A', garmentCodes: s1codes.slice(3, 4) }] } as never, user.id)
        await refuses('a transfer whose tagged piece has moved on cannot be cancelled', () => cancelTransfer(tx, t2b.id, 'ZZTEST mistake', user.id), 'TAGS_MOVED_ON')
        await cancelTransfer(tx, t2.id, 'ZZTEST mistake', user.id)
        check('a direct transfer cancelled: its 3 tags walk back to store A with the stock', (await tags(A.id, S1.id)).filter((g) => s1codes.slice(0, 3).includes(g.code)).length === 3 && (await held(B.id, S1.id)) === 3 + 2 - 1, [(await tags(A.id, S1.id)).length, await held(B.id, S1.id)])
        // ── In transit ──
        const t3 = await move([{ sizeId: S2.id, qty: 10, codes: s2codes }], 'IN_TRANSIT')
        check('10 of size 2 sent in transit with their 10 tags: the tags wait on the road', (await tags(T.id, S2.id)).length === 10 && (await held(T.id, S2.id)) === 10)
        const l3 = t3.lines[0]
        await refuses('a part receipt with no tags named is refused (every piece on the road is tagged)', () => receiveTransfer(tx, t3.id, { lines: [{ lineId: l3.id, qty: 6 }] }, user.id), 'TAGS_NEEDED')
        await receiveTransfer(tx, t3.id, { lines: [{ lineId: l3.id, qty: 5, damagedQty: 1, garmentCodes: s2codes.slice(0, 5), damagedGarmentCodes: s2codes.slice(5, 6) }] }, user.id)
        check('5 arrived good with their tags, 1 damaged: its tag held as R, like the piece', (await tags(B.id, S2.id)).length === 5 && (await tags(B.id, S2.id, 'R')).length === 1 && (await held(B.id, S2.id, 'R')) === 1, [(await tags(B.id, S2.id)).length, (await tags(B.id, S2.id, 'R')).length])
        await sendBackTransfer(tx, t3.id, { lines: [{ lineId: l3.id, qty: 2, garmentCodes: s2codes.slice(6, 8) }] }, user.id)
        check('2 sent back: their tags are back in store A', (await tags(A.id, S2.id)).map((g) => g.code).join() === s2codes.slice(6, 8).join(), (await tags(A.id, S2.id)).map((g) => g.code))
        await writeOffTransfer(tx, t3.id, { reason: 'ZZTEST fell off', lines: [{ lineId: l3.id, qty: 2 }] }, user.id)
        check('the last 2 written off as lost: with all the rest of it gone, their tags are written off too', (await tags(T.id, S2.id)).length === 0 && (await tags(T.id, S2.id, 'A', 'SCRAPPED')).length === 2)

        const free = (await tags(A.id, S1.id)).map((g) => g.code)
        const before4 = free.length
        const t4 = await move([{ sizeId: S1.id, qty: 4, codes: free.slice(0, 4) }], 'IN_TRANSIT')
        await cancelInTransit(tx, t4.id, 'ZZTEST wrong store', user.id)
        check('in transit cancelled: its 4 tags are back in store A', (await tags(A.id, S1.id)).length === before4 && (await tags(T.id, S1.id)).length === 0, [(await tags(A.id, S1.id)).length, before4])

        // ── Scanned ──
        const scanCodes = (await tags(A.id, S1.id)).map((g) => g.code).slice(0, 2)
        const scanned = await moveGarments(tx, { codes: scanCodes, toWarehouseId: B.id }, user.id)
        const scanEvents = await tx.garmentEvent.count({ where: { garment: { code: { in: scanCodes } }, type: 'TRANSFERRED', referenceNumber: scanned.transferNumber } })
        check('a scanned move: the 2 pieces and their tags in store B, one event each', (await tx.garment.count({ where: { code: { in: scanCodes }, warehouseId: B.id } })) === 2 && scanEvents === 2, [scanEvents])

        // ── Stock Reconciliation ──
        const recon = (await stockReconciliation.run({ tx, params: {}, rowCap: 5000 } as never)) as { rows: Array<Record<string, unknown>> }
        const mine = recon.rows.filter((r) => String(r.item).includes(`ZZTEST TG shirt ${stamp}`))
        check('Stock Reconciliation: no tag claims more than its store holds', mine.length === 0, mine)

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
