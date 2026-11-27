/**
 * Fabric by design and colour (the user's decisions, 27 Nov 2026):
 *   - an item filed under Fabric is set up in the Items master with its own
 *     Design No. and Colour, kept exactly as typed ("120" stays "120");
 *   - two fabric items may share a name when their design or colour differs,
 *     never when both match; anything else cannot carry a Design No.;
 *   - a purchase order shows the picked item's design and colour (they come
 *     from the item), and its brand is a reference only — a customer's brand
 *     is refused;
 *   - goods received go into that item's stock like any other.
 *
 * Demo database (lderp_demo) only; what it makes is removed at the end. From
 * the repo root:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5434/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5117/api npx tsx tools/check-fabric-items.ts
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

  const cats = (await call('GET', '/masters/item-categories?limit=200')).body.data as any[]
  const fabricCat = cats.find((c) => /^fabric$/i.test(c.name) && c.parentId)
  const packingCat = cats.find((c) => /packing/i.test(c.name) && c.parentId)
  const mtr = ((await call('GET', '/masters/uoms?limit=100')).body.data as any[]).find((u) => /^(m|mtr|meter|metre)$/i.test(u.symbol))
  const supplier = ((await call('GET', '/masters/suppliers?limit=20')).body.data as any[]).find((s) => !/vhagar/i.test(s.name) && s.gstin)
  const store = ((await call('GET', '/masters/warehouses?limit=50')).body.data as any[]).find((w) => w.purpose !== 'SAMPLING')
  const brands = (await call('GET', '/masters/brands?limit=100')).body.data as any[]
  const ld = brands.find((b) => b.type === 'LD_COTTON_MILLS' && b.isActive && /ld cotton/i.test(b.name))
  const customerBrand = brands.find((b) => b.type === 'CUSTOM')
  const tag = Date.now().toString(36).toUpperCase()
  const name = `ZZTEST Twill ${tag}`
  const items: string[] = []
  const pos: string[] = []
  const add = (body: Record<string, unknown>) =>
    call('POST', '/masters/items', body).then((r) => {
      if (r.body?.data?.id) items.push(r.body.data.id)
      return r
    })
  const fabric = (extra: Record<string, unknown>) => add({ name, type: 'RAW_MATERIAL', categoryId: fabricCat.id, uomId: mtr.id, ...extra })

  try {
    // ── Set up in the Items master ─────────────────────────────────────
    const a = await fabric({ designNo: ' 1164 ', color: 'Navy' })
    check('1. a fabric item keeps its Design No. exactly as typed (1164, nothing added) and its Colour', a.status === 201 && a.body?.data?.designNo === '1164' && a.body?.data?.color === 'Navy', a.body)

    const b = await fabric({ designNo: '1165', color: 'Navy' })
    check('2. the same fabric name in another design is a second item', b.status === 201 && b.body?.data?.id !== a.body?.data?.id, b.body)

    const c = await fabric({ designNo: '1164', color: 'Black' })
    check('3. … and in another colour', c.status === 201, c.body)

    const d = await fabric({ designNo: '1164', color: 'NAVY' })
    check('4. the same name, design and colour twice is refused', d.status >= 400 && /already exists/i.test(JSON.stringify(d.body)), d.body)

    const e = await add({ name: `ZZTEST Tape ${tag}`, type: 'PACKING_MATERIAL', categoryId: packingCat.id, uomId: mtr.id, designNo: '99' })
    check('5. anything not filed under Fabric cannot carry a Design No.', e.status === 400 && e.body?.code === 'DESIGN_NOT_FABRIC', e.body)

    const edited = await call('PATCH', `/masters/items/${a.body.data.id}`, { color: 'Navy Blue' })
    check("6. a fabric item's colour can be corrected in the master", edited.status < 300 && edited.body?.data?.color === 'Navy Blue' && edited.body?.data?.designNo === '1164', edited.body)

    const listed = (await call('GET', `/masters/items?limit=50&q=${encodeURIComponent(name)}`)).body.data as any[]
    check("7. the Items list carries each fabric item's design and colour", listed.length === 3 && listed.every((i) => i.designNo && i.color), listed.map((i) => [i.designNo, i.color]))

    // ── On a purchase order ────────────────────────────────────────────
    const po = await call('POST', '/purchase/orders', { supplierId: supplier.id, brandId: ld.id, lines: [{ itemId: a.body.data.id, qty: 100, unitRate: 220, gstRate: 5 }, { itemId: c.body.data.id, qty: 50, unitRate: 230, gstRate: 5 }] })
    if (po.body?.data?.id) pos.push(po.body.data.id)
    const pl = po.body?.data?.lines ?? []
    check('8. a purchase order takes the fabric items as picked, with their design and colour, and keeps its brand',
      po.status === 201 && pl[0]?.itemId === a.body.data.id && pl[0]?.item?.designNo === '1164' && pl[0]?.item?.color === 'Navy Blue' && pl[1]?.item?.color === 'Black' && po.body?.data?.brand?.id === ld.id,
      po.body)
    const printed = (await call('GET', `/purchase/orders/${po.body?.data?.id}/print`)).body?.data?.order?.lines?.[0]?.item
    check('9. the printed order gets the design and colour from the item', printed?.designNo === '1164' && printed?.color === 'Navy Blue', printed)

    const bad = await call('POST', '/purchase/orders', { supplierId: supplier.id, brandId: customerBrand.id, lines: [{ itemId: a.body.data.id, qty: 1, unitRate: 1, gstRate: 5 }] })
    if (bad.body?.data?.id) pos.push(bad.body.data.id)
    check("10. a customer's brand is refused on a purchase order", bad.status === 400 && bad.body?.code === 'NOT_IN_HOUSE_BRAND', bad.body)

    // ── Received into that item's stock ────────────────────────────────
    await call('PATCH', `/purchase/orders/${po.body.data.id}/send`, {})
    const grn = await call('POST', '/purchase/grn', { poId: po.body.data.id, challanNo: `ZZ-${tag}`, challanDate: new Date().toISOString(), lines: [{ poLineId: pl[0].id, warehouseId: store.id, receivedQty: 40 }] })
    const inStock = await prisma.stockLedger.aggregate({ where: { itemId: a.body.data.id, referenceId: grn.body?.data?.id }, _sum: { inQty: true } })
    check("11. goods received go into that fabric item's own stock", grn.status < 300 && Number(inStock._sum.inQty) === 40, { grn: grn.status, msg: grn.body?.message, inStock: inStock._sum.inQty })
    if (grn.body?.data?.id) await call('DELETE', `/purchase/grn/${grn.body.data.id}`, { reason: 'test' })
  } finally {
    for (const id of pos) {
      await call('DELETE', `/purchase/orders/${id}`)
      await call('DELETE', `/purchase/recycle-bin/${id}`)
    }
    for (const id of items) {
      const used = await prisma.stockLedger.count({ where: { itemId: id } })
      if (used) await prisma.item.update({ where: { id }, data: { isActive: false } })
      else {
        await prisma.itemUnit.deleteMany({ where: { itemId: id } })
        await prisma.item.delete({ where: { id } }).catch(() => prisma.item.update({ where: { id }, data: { isActive: false } }))
      }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}
main().finally(() => prisma.$disconnect())
