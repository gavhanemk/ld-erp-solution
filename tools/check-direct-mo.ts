/**
 * Checks a direct manufacturing order (no sales order, for stock or samples):
 * the form's style lookups, the finished item made for a new colour, the
 * order raised under an in-house brand with its style, colour and sizes,
 * edited, released (job cards made), linked to a sales order later and given
 * back to stock, and its packed pieces checked against what it makes —
 * against a running API and the demo database (lderp_demo) only. Refuses any
 * other database. Uses the ZZTEST style and customer, never VHAGAR's. From
 * apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-direct-mo.ts
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 600)}` : ''}`)
}
type Res = { status: number; body: any }
let token = ''
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  let j: any = null
  try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
const okay = (r: Res) => r.status >= 200 && r.status < 300

async function main() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) { console.error('Set E2E_EMAIL and E2E_PASSWORD.'); process.exitCode = 2; return }
  const [{ current_database: dbName }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (dbName !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  token = (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())).accessToken
  if (!token) throw new Error('login failed')
  const stamp = Date.now().toString().slice(-6)

  const st = await prisma.style.findFirstOrThrow({ where: { code: 'ZZTEST-SH-01' }, select: { id: true, code: true, isActive: true, colors: true, sizeGroupId: true } })
  const colour = `D${stamp}`
  await prisma.style.update({ where: { id: st.id }, data: { isActive: true, colors: [...st.colors, colour] } })
  try {
    const ldBrand = await prisma.brand.findFirstOrThrow({ where: { type: 'LD_COTTON_MILLS', isActive: true, name: { contains: 'LD Cotton', mode: 'insensitive' } }, select: { id: true, name: true } })
    const custBrand = await call('POST', '/masters/brands', { name: `ZZTEST DCust ${stamp}`, type: 'CUSTOM', isActive: true })

    // 1. The form's lookups.
    const styles = (await call('GET', '/production/direct/styles')).body?.data ?? []
    check('direct styles: the test style is offered', styles.some((s: any) => s.id === st.id), styles.length)
    const sizes = await prisma.size.findMany({ where: { sizeGroupId: st.sizeGroupId! }, orderBy: { sequence: 'asc' }, take: 2, select: { id: true, code: true } })
    let info = (await call('GET', `/production/direct/styles/${st.id}`)).body?.data
    const mine = info?.colours?.find((c: any) => c.color === colour)
    check('style detail: its sizes, and the new colour with no finished item yet', info?.sizes?.length >= 2 && !!mine && mine.item === null, { sizes: info?.sizes?.length, mine })

    // 2. No finished item yet: refused; then added on the Items & Products form, started from the style's other colours.
    const line = { styleId: st.id, color: colour, sizes: [{ sizeId: sizes[0].id, qty: 30 }, { sizeId: sizes[1].id, qty: 20 }] }
    const noItem = await call('POST', '/production/orders', { brandId: ldBrand.id, purpose: 'STOCK', lines: [line] })
    check('no finished item for the colour: refused, saying to add it', noItem.status === 400 && noItem.body?.code === 'NO_ITEM' && /Add item/.test(noItem.body?.message ?? ''), noItem.body)
    const gone = await call('POST', '/production/direct/colour-item', { styleId: st.id, colour })
    check('no item is made by production on its own any more', gone.status === 404, gone.status)
    const tplRes = (await call('GET', `/production/direct/item-template?styleId=${st.id}&colour=${encodeURIComponent(colour)}`)).body?.data
    const tpl = tplRes?.values
    // Its rate: the approved BOM's cost per piece (the colour's, else the style's colourless one), and which BOM.
    const boms = await prisma.bOM.findMany({ where: { styleId: st.id, status: 'APPROVED', isActive: true }, select: { version: true, color: true, costPerPiece: true, approvedAt: true, createdAt: true }, orderBy: [{ approvedAt: 'desc' }, { createdAt: 'desc' }] })
    const want = boms.find((b) => (b.color ?? '').trim().toLowerCase() === colour.toLowerCase()) ?? boms.find((b) => !b.color?.trim()) ?? null
    check(
      "the rate is the approved BOM's cost per piece, and says which BOM",
      want?.costPerPiece != null
        ? tpl?.standardRate === Number(want.costPerPiece) && tplRes?.rateFrom?.version === want.version && tplRes?.rateFrom?.costPerPiece === Number(want.costPerPiece)
        : tpl?.standardRate === undefined && tplRes?.rateFrom === null,
      { want, got: tpl?.standardRate, rateFrom: tplRes?.rateFrom },
    )
    check('the item form starts as a finished good of the style in that colour, like its other colours', tpl?.group === 'FINISHED_GOODS' && tpl?.styleId === st.id && tpl?.color === colour && !!tpl?.uomId && !!(tpl?.subCategoryId || tpl?.mainCategoryId), tpl)
    // Saved as the form saves it: through Items & Products.
    const made = await call('POST', '/masters/items', {
      name: tpl.name,
      // No type, as the form sends it: the category gives it.
      categoryId: tpl.subCategoryId ?? tpl.mainCategoryId,
      uomId: tpl.uomId,
      styleId: tpl.styleId,
      color: tpl.color,
      ...(tpl.hsnCode ? { hsnCode: tpl.hsnCode } : {}),
      ...(tpl.standardRate != null ? { standardRate: tpl.standardRate } : {}),
    })
    check('added on Items & Products, a finished good by its category', (made.status === 201 || made.status === 200) && made.body?.data?.type === 'FINISHED_GOOD', made.body)
    const item = made.body.data
    if (item?.id) await prisma.item.update({ where: { id: item.id }, data: { hsnCode: '6205' } })
    info = (await call('GET', `/production/direct/styles/${st.id}`)).body?.data
    check('style detail now shows it', info?.colours?.find((c: any) => c.color === colour)?.item?.id === item?.id)

    // 3. The order itself: brand checks, then raised for stock.
    const noBrand = await call('POST', '/production/orders', { purpose: 'STOCK', lines: [line] })
    check('no brand: refused', noBrand.status === 400, noBrand.body)
    const custMo = await call('POST', '/production/orders', { brandId: custBrand.body.data.id, purpose: 'STOCK', lines: [line] })
    check("a customer's brand: refused", custMo.status === 400 && custMo.body?.code === 'NOT_OWN_BRAND', custMo.body)
    const badColour = await call('POST', '/production/orders', { brandId: ldBrand.id, lines: [{ ...line, color: 'No Such Colour' }] })
    check('a colour the style does not come in: refused', badColour.status === 400 && badColour.body?.code === 'BAD_COLOUR', badColour.body)
    const mo = await call('POST', '/production/orders', { brandId: ldBrand.id, purpose: 'STOCK', notes: `ZZ direct ${stamp}`, lines: [line] })
    const moId = mo.body?.data?.id
    check('a direct order for stock: saved as a draft, 50 pcs for stock', mo.status === 201 && /50 pcs for stock/.test(mo.body?.message ?? ''), mo.body?.message ?? mo.body)
    const row = moId ? await prisma.manufacturingOrder.findUnique({ where: { id: moId }, select: { soId: true, purpose: true, brandId: true, totalPlannedQty: true, lines: { select: { soLineId: true, color: true, totalQty: true, bomId: true, sizes: true } } } }) : null
    check('no sales order, purpose stock, our brand, its line by size', !!row && row.soId === null && row.purpose === 'STOCK' && row.brandId === ldBrand.id && row.totalPlannedQty === 50 && row.lines[0]?.soLineId === null && row.lines[0]?.sizes.length === 2, row)

    // 4. Changed while a draft: now samples, more pieces.
    const edit = await call('PATCH', `/production/orders/${moId}`, { purpose: 'SAMPLE', lines: [{ ...line, sizes: [{ sizeId: sizes[0].id, qty: 40 }, { sizeId: sizes[1].id, qty: 20 }] }] })
    const edited = await prisma.manufacturingOrder.findUnique({ where: { id: moId }, select: { purpose: true, totalPlannedQty: true } })
    check('edited: samples, 60 pcs', okay(edit) && edited?.purpose === 'SAMPLE' && edited.totalPlannedQty === 60, edit.body)

    // 5. Released: its job cards made, like any order.
    const rel = await call('POST', `/production/orders/${moId}/release`, {})
    const cards = await prisma.jobCard.count({ where: { moId } })
    check('released to the floor, with its job card', okay(rel) && cards >= 1, rel.body?.message ?? rel.body)

    // 6. Linked to a sales order later, then given back.
    const customer = await prisma.customer.findFirstOrThrow({ where: { name: { startsWith: 'ZZTEST' }, isActive: true }, select: { id: true } })
    const so = await call('POST', '/sales/orders', {
      customerId: customer.id,
      brandId: ldBrand.id,
      isJobWork: false,
      customerPORef: `ZZ-DM-${stamp}`,
      confirm: true,
      creditReleaseReason: 'Demo test order',
      lines: [{ itemId: item.id, totalQty: 45, unitPrice: 300, sizes: [{ sizeId: sizes[0].id, qty: 25 }, { sizeId: sizes[1].id, qty: 20 }] }],
    })
    const soId = so.body?.data?.id
    check('setup: a sales order for the same item', so.status === 201 && !!soId, so.body?.message ?? so.body)
    const other = await prisma.salesOrder.findFirst({ where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION'] }, isJobWork: false, id: { not: soId }, lines: { none: { itemId: item.id } } }, select: { id: true, soNumber: true } })
    if (other) {
      const wrong = await call('POST', `/production/orders/${moId}/link`, { soId: other.id })
      check('linking to an order without its style: refused', wrong.status === 400 && wrong.body?.code === 'NOT_ON_ORDER', wrong.body)
    }
    const linkable = (await call('GET', `/production/orders/${moId}/linkable`)).body?.data ?? []
    check('the orders it can be made for: the one with its style and colour', linkable.some((x: any) => x.id === soId) && (!other || !linkable.some((x: any) => x.id === other.id)), linkable.map((x: any) => x.soNumber))
    const directList = (await call('GET', '/production/orders?direct=1&limit=100')).body?.data ?? []
    check('the direct list: it, for samples, and no order raised from a sales order', directList.some((m: any) => m.id === moId && m.purpose === 'SAMPLE') && directList.every((m: any) => !m.soNumber), directList.length)
    const link = await call('POST', `/production/orders/${moId}/link`, { soId })
    const linked = await prisma.manufacturingOrder.findUnique({ where: { id: moId }, select: { soId: true, purpose: true, lines: { select: { soLineId: true } } } })
    check('linked: made for the order, each line on its order line', okay(link) && linked?.soId === soId && linked.lines.every((l) => !!l.soLineId), link.body)
    check('the message says what goes beyond the order to stock', /15 pcs more than the order still needs go to stock/.test(link.body?.message ?? ''), link.body?.message)
    const soAfter = await prisma.salesOrder.findUnique({ where: { id: soId }, select: { status: true } })
    check('the order goes into production', soAfter?.status === 'IN_PRODUCTION', soAfter)
    const again = await call('POST', `/production/orders/${moId}/link`, { soId })
    check('linking twice: refused', again.status === 409 && again.body?.code === 'HAS_ORDER', again.body)
    const unlink = await call('POST', `/production/orders/${moId}/unlink`, {})
    const back = await prisma.manufacturingOrder.findUnique({ where: { id: moId }, select: { soId: true, purpose: true, lines: { select: { soLineId: true } } } })
    check('given back: samples again, no order line', okay(unlink) && back?.soId === null && back.purpose === 'SAMPLE' && back.lines.every((l) => !l.soLineId), unlink.body)
    const ownSoMo = await prisma.manufacturingOrder.findFirst({ where: { purpose: 'ORDER', soId: { not: null }, status: { notIn: ['COMPLETED', 'CLOSED'] } }, select: { id: true } })
    if (ownSoMo) {
      const refuse = await call('POST', `/production/orders/${ownSoMo.id}/unlink`, {})
      check('an order raised from a sales order cannot be unlinked', refuse.status === 409 && refuse.body?.code === 'RAISED_FOR_ORDER', refuse.body)
    }

    // 6b. Made for a customer with no sales order: who, and only their orders can take it.
    const noCust = await call('POST', '/production/orders', { brandId: ldBrand.id, purpose: 'CUSTOMER', lines: [line] })
    check('for a customer, none picked: refused', noCust.status === 400, noCust.body)
    const custName = (await prisma.customer.findUniqueOrThrow({ where: { id: customer.id }, select: { name: true } })).name
    const forCust = await call('POST', '/production/orders', { brandId: ldBrand.id, purpose: 'CUSTOMER', customerId: customer.id, lines: [line] })
    const forCustId = forCust.body?.data?.id
    check(`for a customer: saved, said as for ${custName}`, forCust.status === 201 && forCust.body?.data?.customerId === customer.id && new RegExp(`pcs for ${custName}`).test(forCust.body?.message ?? ''), forCust.body?.message ?? forCust.body)
    const listed = ((await call('GET', `/production/orders?direct=1&limit=100`)).body?.data ?? []).find((m: any) => m.id === forCustId)
    check('the list shows the customer, with no sales order', listed?.customer === custName && listed?.soNumber === null && listed?.purpose === 'CUSTOMER', listed)
    const otherCust = await prisma.salesOrder.findFirst({
      where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION'] }, isJobWork: false, customerId: { not: customer.id }, lines: { some: { itemId: item.id } } },
      select: { id: true },
    })
    const forCustLinkable = (await call('GET', `/production/orders/${forCustId}/linkable`)).body?.data ?? []
    check("its linkable orders: only that customer's", forCustLinkable.length > 0 && forCustLinkable.every((x: any) => x.customer === custName), forCustLinkable.map((x: any) => x.customer))
    if (otherCust) {
      const wrongCust = await call('POST', `/production/orders/${forCustId}/link`, { soId: otherCust.id })
      check("another customer's order: refused", wrongCust.status === 400 && wrongCust.body?.code === 'OTHER_CUSTOMER', wrongCust.body)
    }
    const toStock = await call('PATCH', `/production/orders/${forCustId}`, { purpose: 'STOCK', lines: [line] })
    const nowStock = await prisma.manufacturingOrder.findUnique({ where: { id: forCustId }, select: { purpose: true, customerId: true } })
    check('changed to stock: the customer comes off', okay(toStock) && nowStock?.purpose === 'STOCK' && nowStock.customerId === null, nowStock)
    await call('POST', `/production/orders/${forCustId}/close`, { reason: 'Test of a direct order for a customer' })

    // 7. Packed pieces have to be what it makes.
    const store = await prisma.warehouse.findFirstOrThrow({ where: { name: 'Store', isActive: true, departmentId: null }, select: { id: true } })
    const otherItem = await prisma.item.findFirst({ where: { type: 'FINISHED_GOOD', isActive: true, styleId: { not: st.id } }, select: { id: true } })
    if (otherItem) {
      const stray = await call('POST', '/finished-goods', { warehouseId: store.id, moId, lines: [{ itemId: otherItem.id, qty: 1 }] })
      check('a garment it does not make: refused on finished goods in', stray.status === 400 && stray.body?.code === 'NOT_ON_MO', stray.body)
    }

    // 8. Track & Trace: the order, for samples, with its own brand.
    const tr = await call('GET', `/trace/order/MO/${moId}`)
    check('Track & Trace: no sales order, its purpose and brand', okay(tr) && tr.body?.data?.so === null && tr.body?.data?.mos?.[0]?.purpose === 'SAMPLE' && tr.body?.data?.mos?.[0]?.brand?.name === ldBrand.name, tr.body?.data?.mos?.[0])

    await call('PATCH', `/masters/brands/${custBrand.body?.data?.id}`, { isActive: false })
  } finally {
    await prisma.style.update({ where: { id: st.id }, data: { isActive: st.isActive, colors: st.colors } })
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
