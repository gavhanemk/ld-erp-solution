/**
 * Fabric by design, colour and brand (the user's decisions, 27 Nov 2026):
 *   - a purchase order row for a Fabric item with a Design No. / Colour, and
 *     the order's in-house brand, is bought into the fabric's own stock line,
 *     made the first time and found again after ("D.NO 1164" = "1164", any case);
 *   - brand is optional; a customer's brand is refused; other items are never split;
 *   - one fabric in two colours is two rows on one order;
 *   - changing an order's brand moves its fabric lines to that brand's lines;
 *   - goods received go into the fabric line's own stock;
 *   - a manufacturing order may not draw another brand's fabric.
 *
 * Demo database (lderp_demo) only; what it makes is deleted or switched off at
 * the end. From the repo root:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5434/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5117/api npx tsx tools/check-fabric-lines.ts
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 400)}` : ''}`)
}

async function main() {
  const [{ current_database: db }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (db !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD }) }).then((r) => r.json())
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${login.accessToken}` }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, body: (await r.json().catch(() => null)) as any }
  }

  const items = (await call('GET', '/masters/items?limit=500&active=true&fabricLines=0')).body.data as any[]
  const isFabric = (i: any) => /fabric/i.test(`${i.category?.name ?? ''} ${i.category?.parent?.name ?? ''}`)
  const fabric = items.find((i) => isFabric(i) && !/vhagar/i.test(i.name))
  const other = items.find((i) => !isFabric(i) && !/vhagar/i.test(i.name) && ['RAW_MATERIAL', 'TRIM', 'PACKING_MATERIAL'].includes(i.type))
  const supplier = ((await call('GET', '/masters/suppliers?limit=20')).body.data as any[]).find((s) => !/vhagar/i.test(s.name) && s.gstin)
  const store = ((await call('GET', '/masters/warehouses?limit=50')).body.data as any[]).find((w) => w.purpose !== 'SAMPLING')
  const brands = (await call('GET', '/masters/brands?limit=100')).body.data as any[]
  const ld = brands.find((b) => b.type === 'LD_COTTON_MILLS' && b.isActive && /ld cotton/i.test(b.name))
  const customerBrand = brands.find((b) => b.type === 'CUSTOM')
  // A second in-house brand of our own, switched off again at the end.
  const second = (await call('POST', '/masters/brands', { name: `ZZTEST Fabric Brand ${Date.now().toString(36)}`, type: 'LD_COTTON_MILLS', isActive: true })).body?.data
  const made: string[] = []
  const line = (extra: Record<string, unknown>) => ({ itemId: fabric.id, qty: 100, unitRate: 220, gstRate: 5, ...extra })
  const newPo = async (body: Record<string, unknown>) => {
    const r = await call('POST', '/purchase/orders', { supplierId: supplier.id, ...body })
    if (r.body?.data?.id) made.push(r.body.data.id)
    return r
  }

  try {
    // ── A fabric line is made, and found again ─────────────────────────
    const a = await newPo({ brandId: ld.id, lines: [line({ designNo: 'D.NO. 1164', color: 'Navy' })] })
    const aItem = a.body?.data?.lines?.[0]?.item
    check('1. a fabric row with design, colour and brand goes into a line of its own under the fabric',
      a.status === 201 && aItem?.parentItem?.id === fabric.id && aItem?.designNo === '1164' && aItem?.color === 'Navy' && aItem?.brandId === ld.id,
      { status: a.status, aItem })
    check(`2. it is named for what it is ("${aItem?.name}")`, /D\.No 1164 · Navy · LD Cotton Mills$/.test(aItem?.name ?? ''), aItem?.name)

    const b = await newPo({ brandId: ld.id, lines: [line({ designNo: '1164', color: 'navy' })] })
    check('3. the same design and colour, typed differently, finds the same line', b.body?.data?.lines?.[0]?.itemId === a.body?.data?.lines?.[0]?.itemId, b.body?.data?.lines?.[0]?.item)

    const c = await newPo({ lines: [line({ designNo: '1164', color: 'Navy' })] })
    check('4. with no brand it is a common line, kept apart from the brand\'s', c.status === 201 && c.body?.data?.lines?.[0]?.item?.brandId === null && c.body?.data?.lines?.[0]?.itemId !== a.body?.data?.lines?.[0]?.itemId, c.body?.data?.lines?.[0]?.item)

    const d = await newPo({ brandId: ld.id, lines: [line({ designNo: '1164', color: 'Navy' }), line({ designNo: '1164', color: 'Black' })] })
    const dl = d.body?.data?.lines ?? []
    check('5. one fabric in two colours is two rows on one order, two lines in stock', d.status === 201 && dl.length === 2 && dl[0].itemId !== dl[1].itemId, d.body)

    const e = await newPo({ brandId: ld.id, lines: [{ itemId: other.id, qty: 10, unitRate: 10, gstRate: 18, designNo: '99', color: 'Red' }] })
    check(`6. anything that is not fabric (${other.name}) is never split`, e.status === 201 && e.body?.data?.lines?.[0]?.itemId === other.id, e.body?.data?.lines?.[0])

    const f = await call('POST', '/purchase/orders', { supplierId: supplier.id, brandId: customerBrand.id, lines: [line({ designNo: '1', color: 'X' })] })
    check("7. a customer's brand is refused on a purchase order", f.status === 400 && f.body?.code === 'NOT_IN_HOUSE_BRAND', f.body)

    // ── Changing the brand moves the fabric lines ──────────────────────
    const moved = await call('PATCH', `/purchase/orders/${a.body.data.id}`, { brandId: second.id })
    const movedItem = moved.body?.data?.lines?.[0]?.item
    check('8. changing the order\'s brand moves its fabric to that brand\'s line', moved.status < 300 && movedItem?.brandId === second.id && movedItem?.designNo === '1164' && movedItem?.color === 'Navy', moved.body)

    // ── Item lists ─────────────────────────────────────────────────────
    const plain = (await call('GET', `/masters/items?limit=500&active=true&fabricLines=0&q=${encodeURIComponent(fabric.name)}`)).body.data as any[]
    const lines = (await call('GET', `/masters/items?limit=500&fabricLines=1&parentItemId=${fabric.id}`)).body.data as any[]
    check('9. the order form\'s item list leaves fabric lines out; the fabric\'s lines can be listed', !plain.some((i) => i.parentItemId) && lines.length >= 4, { plain: plain.length, lines: lines.length })

    // ── Received into the line's own stock ─────────────────────────────
    await call('PATCH', `/purchase/orders/${b.body.data.id}/send`, {})
    const poLine = (await call('GET', `/purchase/orders/${b.body.data.id}`)).body?.data?.lines?.[0]
    const grn = await call('POST', '/purchase/grn', { poId: b.body.data.id, challanNo: `ZZ-${Date.now()}`, challanDate: new Date().toISOString(), lines: [{ poLineId: poLine.id, warehouseId: store.id, receivedQty: 40 }] })
    const inStock = await prisma.stockLedger.aggregate({ where: { itemId: poLine.itemId, referenceId: grn.body?.data?.id }, _sum: { inQty: true } })
    check('10. goods received go into the fabric line\'s own stock', grn.status < 300 && Number(inStock._sum.inQty) === 40, { grn: grn.status, body: grn.body?.message, inStock: inStock._sum.inQty })
    if (grn.body?.data?.id) await call('DELETE', `/purchase/grn/${grn.body.data.id}`, { reason: 'test' })

    // ── A manufacturing order draws its own brand's fabric only ────────
    const mo = await prisma.manufacturingOrder.findFirst({ where: { brandId: ld.id }, select: { id: true, moNumber: true } })
    const dept = await prisma.department.findFirst({ select: { id: true } })
    if (mo && dept) {
      const otherBrandLine = moved.body.data.lines[0].itemId
      const r = await call('POST', '/inventory/requisitions', { departmentId: dept.id, moId: mo.id, warehouseId: store.id, lines: [{ itemId: otherBrandLine, requestedQty: 1, warehouseId: store.id }] })
      check(`11. ${mo.moNumber} (LD Cotton Mills) cannot ask for another brand's fabric`, r.status === 409 && r.body?.code === 'OTHER_BRAND_FABRIC', r.body)
      const plan = await call('GET', `/production/orders/${mo.id}/materials`)
      const rows = plan.body?.data?.rows as any[] | undefined
      check('12. the order\'s material plan offers fabric lines only of its own brand or common', Array.isArray(rows) && rows.every((row) => (row.fabricLines ?? []).every((l: any) => !l.brand || l.brand === 'LD Cotton Mills')), plan.body?.message ?? rows?.map((r) => r.fabricLines))
    } else {
      console.log('SKIP  11–12: no manufacturing order for LD Cotton Mills on this database')
    }
  } finally {
    for (const id of made.reverse()) {
      await call('DELETE', `/purchase/orders/${id}`)
      await call('DELETE', `/purchase/recycle-bin/${id}`)
    }
    // The fabric lines made here, and the test brand, go again.
    const lines = await prisma.item.findMany({ where: { parentItemId: fabric.id, OR: [{ designNo: '1164' }, { brandId: second?.id }] }, select: { id: true } })
    for (const l of lines) {
      const used = await prisma.stockLedger.count({ where: { itemId: l.id } })
      if (!used) {
        await prisma.itemUnit.deleteMany({ where: { itemId: l.id } })
        await prisma.item.delete({ where: { id: l.id } }).catch(() => prisma.item.update({ where: { id: l.id }, data: { isActive: false } }))
      } else await prisma.item.update({ where: { id: l.id }, data: { isActive: false } })
    }
    if (second?.id) await prisma.brand.delete({ where: { id: second.id } }).catch(() => prisma.brand.update({ where: { id: second.id }, data: { isActive: false } }))
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}
main().finally(() => prisma.$disconnect())
