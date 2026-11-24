/**
 * Checks finished-goods cartons against a running API and the demo database
 * (lderp_demo) only — refuses any other. Each run makes its own colour of the
 * ZZTEST style (never VHAGAR), brings its pieces in as opening stock, packs
 * them, and sends them on a delivery challan by scanning the cartons.
 * From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-fg-cartons.ts
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 700)}` : ''}`)
}
type Res = { status: number; body: any }
let token = ''
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  let j: any = null
  try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
const ledger = async (itemId: string, warehouseId: string, sizeId: string) =>
  Number((await prisma.stockLedger.aggregate({ where: { itemId, warehouseId, sizeId, grade: 'A', ownership: 'OWNED' }, _sum: { inQty: true, outQty: true } }))._sum.inQty ?? 0) -
  Number((await prisma.stockLedger.aggregate({ where: { itemId, warehouseId, sizeId, grade: 'A', ownership: 'OWNED' }, _sum: { outQty: true } }))._sum.outQty ?? 0)

async function main() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) { console.error('Set E2E_EMAIL and E2E_PASSWORD.'); process.exitCode = 2; return }
  const [{ current_database: dbName }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (dbName !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  token = (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())).accessToken
  if (!token) throw new Error('login failed')
  const stamp = Date.now().toString().slice(-6)
  const today = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10)

  // The test style, on for the run, with a colour of this run's own.
  const st = await prisma.style.findFirstOrThrow({ where: { code: 'ZZTEST-SH-01' }, select: { id: true, code: true, isActive: true, colors: true, sizeGroupId: true } })
  const colour = `K${stamp}`
  await prisma.style.update({ where: { id: st.id }, data: { isActive: true, colors: [...st.colors, colour] } })
  try {
    const made = await call('POST', '/inventory/opening-stock/colour-item', { styleId: st.id, colour })
    const item = made.body?.data?.item
    // Its garments' HSN, so an order can be raised for it.
    if (item?.id) await prisma.item.update({ where: { id: item.id }, data: { hsnCode: '6205' } })
    const other = await prisma.item.findFirstOrThrow({ where: { styleId: st.id, type: 'FINISHED_GOOD', isActive: true, id: { not: item?.id } }, select: { id: true, code: true } })
    const sizes = await prisma.size.findMany({ where: { sizeGroupId: st.sizeGroupId! }, orderBy: { sequence: 'asc' }, take: 2, select: { id: true, code: true } })
    const [s1, s2] = sizes
    const store = await prisma.warehouse.findFirstOrThrow({ where: { name: 'Store', isActive: true, departmentId: null }, select: { id: true, name: true } })
    check('setup: a colour item of the test style', !!item?.id && sizes.length === 2, made.body)

    // Its pieces in the store, as opening stock: 30 of the first size, 20 of the second.
    const os = await call('POST', '/inventory/opening-stock/entry', {
      kind: 'FG',
      confirm: true,
      requestKey: `zz-cartons-${stamp}`,
      lines: [
        { date: today, process: 'Finished Goods', location: store.name, style: st.code, code: item.code, colour, size: s1.code, qty: 30, rate: 100 },
        { date: today, process: 'Finished Goods', location: store.name, style: st.code, code: item.code, colour, size: s2.code, qty: 20, rate: 100 },
      ],
    })
    check('30 + 20 pieces in the store', os.status === 201, os.body)

    const stock = (await call('GET', `/fg-cartons/stock?warehouseId=${store.id}`)).body?.data ?? []
    const mine = stock.find((i: any) => i.id === item.id)
    check('free to pack: 30 and 20, nothing packed yet', mine?.sizes?.find((z: any) => z.sizeId === s1.id)?.free === 30 && mine?.sizes?.find((z: any) => z.sizeId === s2.id)?.free === 20, mine)

    // 1. A carton for no order: 10 + 5.
    const c1 = await call('POST', '/fg-cartons', { warehouseId: store.id, lines: [{ itemId: item.id, sizeId: s1.id, qty: 10 }, { itemId: item.id, sizeId: s2.id, qty: 5 }] })
    check('carton packed: CT code, 15 pcs', c1.status === 201 && /^CT-\d{4,}$/.test(c1.body?.data?.code ?? '') && c1.body?.data?.pieces === 15, c1.body)
    const over = await call('POST', '/fg-cartons', { warehouseId: store.id, lines: [{ itemId: item.id, sizeId: s2.id, qty: 16 }] })
    check('more than is free: refused, saying how many are free', over.status === 400 && /Only 15 pcs/.test(over.body?.message ?? ''), over.body)
    const floor = await prisma.warehouse.findFirst({ where: { departmentId: { not: null }, isActive: true }, select: { id: true } })
    if (floor) {
      const onFloor = await call('POST', '/fg-cartons', { warehouseId: floor.id, lines: [{ itemId: item.id, sizeId: s1.id, qty: 1 }] })
      check('not on a process floor', onFloor.status === 400 && onFloor.body?.code === 'NOT_A_STORE', onFloor.body)
    }

    // 2. An order for the item, and a carton packed for it.
    const customer = await prisma.customer.findFirstOrThrow({ where: { name: { startsWith: 'ZZTEST' } }, select: { id: true } })
    const so = await call('POST', '/sales/orders', {
      customerId: customer.id,
      isJobWork: false,
      customerPORef: `ZZ-CT-${stamp}`,
      confirm: true,
      creditReleaseReason: 'Demo test order',
      lines: [{ itemId: item.id, totalQty: 50, unitPrice: 300, sizes: [{ sizeId: s1.id, qty: 30 }, { sizeId: s2.id, qty: 20 }] }],
    })
    const soId = so.body?.data?.id
    check('an order for the item, confirmed', so.status === 201 && !!soId, so.body?.message ?? so.body)
    const c2 = await call('POST', '/fg-cartons', { warehouseId: store.id, soId, lines: [{ itemId: item.id, sizeId: s1.id, qty: 10 }] })
    check('carton packed for the order: its number said', c2.status === 201 && c2.body?.data?.order?.soNumber && new RegExp(c2.body.data.order.soNumber).test(c2.body?.message ?? ''), c2.body)
    const offOrder = await call('POST', '/fg-cartons', { warehouseId: store.id, soId, lines: [{ itemId: other.id, sizeId: s1.id, qty: 1 }] })
    check('an item not on the order: refused', offOrder.status === 400 && offOrder.body?.code === 'NOT_ON_ORDER', offOrder.body)

    // 3. Sealed pieces do not leave on a typed challan.
    const soLine = (await prisma.salesOrderLine.findFirstOrThrow({ where: { soId, itemId: item.id }, select: { id: true } })).id
    const typed = await call('POST', '/sales/challans', { soId, warehouseId: store.id, dispatch: true, lines: [{ soLineId: soLine, sizes: [{ sizeId: s1.id, qty: 15 }] }] })
    check('a typed challan taking sealed pieces: refused, naming the cartons', typed.status === 400 && typed.body?.code === 'PACKED_IN_CARTONS' && typed.body?.message?.includes(c1.body?.data?.code), typed.body)

    // 4. Cartons scanned onto a challan.
    const avail = (await call('GET', `/fg-cartons/dispatch/available?soId=${soId}`)).body?.data ?? []
    check('to pick for the order: the carton packed for it and the one for no order', [c1.body.data.id, c2.body.data.id].every((id) => avail.some((c: any) => c.id === id)), avail.map((c: any) => c.code))
    const scan1 = await call('POST', '/fg-cartons/dispatch/scan', { soId, code: c2.body.data.code.toLowerCase().replace('-', ' ') })
    const dcId = scan1.body?.data?.dcId
    check('the first carton scanned starts a draft challan from its store', scan1.status === 200 && !!dcId && scan1.body?.data?.pieces === 10, scan1.body)
    const scan2 = await call('POST', '/fg-cartons/dispatch/scan', { soId, dcId, code: c1.body.data.code })
    check('the second: 2 cartons, 25 pcs', scan2.status === 200 && scan2.body?.data?.cartons?.length === 2 && scan2.body?.data?.pieces === 25, scan2.body?.data && { n: scan2.body.data.cartons.length, p: scan2.body.data.pieces })
    const again = await call('POST', '/fg-cartons/dispatch/scan', { soId, dcId, code: c1.body.data.code })
    check('the same carton again: refused', again.status === 409 && again.body?.code === 'ALREADY_ON', again.body)
    const dcLines = await prisma.deliveryChallanLine.findMany({ where: { dcId }, include: { sizes: true } })
    const sizeQty = (sid: string) => dcLines.flatMap((l) => l.sizes).filter((z) => z.sizeId === sid).reduce((t, z) => t + Number(z.qty), 0)
    check("the challan's lines are the cartons': 20 and 5", sizeQty(s1.id) === 20 && sizeQty(s2.id) === 5, dcLines.map((l) => l.sizes.map((z) => [z.sizeId === s1.id ? s1.code : s2.code, Number(z.qty)])))
    const edit = await call('PATCH', `/sales/challans/${dcId}`, { soId, warehouseId: store.id, lines: [{ soLineId: soLine, sizes: [{ sizeId: s1.id, qty: 1 }] }] })
    check('a challan with cartons is not typed over', edit.status === 409 && edit.body?.code === 'HAS_CARTONS', edit.body)
    const off = await call('DELETE', `/fg-cartons/dispatch/${dcId}/cartons/${c1.body.data.id}`)
    check('a carton taken off: 10 pcs left on it', off.status === 200 && off.body?.data?.pieces === 10, off.body)
    await call('POST', '/fg-cartons/dispatch/scan', { soId, dcId, code: c1.body.data.code })

    const s1Before = await ledger(item.id, store.id, s1.id)
    const sent = await call('POST', `/fg-cartons/dispatch/${dcId}/dispatch`, { vehicleNumber: 'mh12ab1234' })
    check('dispatched: 2 cartons, 25 pcs', sent.status === 200 && /2 cartons, 25 pcs/.test(sent.body?.message ?? ''), sent.body)
    const s1After = await ledger(item.id, store.id, s1.id)
    check('the stock went down by what the cartons held', Math.abs(s1Before - s1After - 20) < 1e-9, { s1Before, s1After })
    const scanned = await call('GET', `/fg-cartons/scan/${c1.body.data.code}`)
    check('scanned after: dispatched, on its challan', scanned.body?.data?.status === 'DISPATCHED' && scanned.body?.data?.challan?.status === 'DISPATCHED', scanned.body?.data && { s: scanned.body.data.status, dc: scanned.body.data.challan })
    const dc = await prisma.deliveryChallan.findUniqueOrThrow({ where: { id: dcId }, select: { cartons: true, vehicleNumber: true } })
    check('the challan counts its cartons', dc.cartons === 2 && dc.vehicleNumber === 'MH12AB1234', dc)

    // 5. Opened: its pieces loose again.
    const c3 = await call('POST', '/fg-cartons', { warehouseId: store.id, lines: [{ itemId: item.id, sizeId: s2.id, qty: 5 }] })
    const opened = await call('POST', `/fg-cartons/${c3.body?.data?.id}/open`, { reason: 'repacked by size' })
    check('a carton opened', opened.status === 200 && opened.body?.data?.status === 'OPENED', opened.body)
    const stock2 = (await call('GET', `/fg-cartons/stock?warehouseId=${store.id}`)).body?.data ?? []
    const free2 = stock2.find((i: any) => i.id === item.id)?.sizes?.find((z: any) => z.sizeId === s2.id)
    check('its pieces free again: 15 of the second size', free2?.inStock === 15 && free2?.packed === 0 && free2?.free === 15, free2)

    // 6. A challan cancelled: its carton back in the store, sealed.
    const c4 = await call('POST', '/fg-cartons', { warehouseId: store.id, soId, lines: [{ itemId: item.id, sizeId: s2.id, qty: 4 }] })
    const scan4 = await call('POST', '/fg-cartons/dispatch/scan', { soId, code: c4.body?.data?.code })
    const cancelled = await call('POST', `/sales/challans/${scan4.body?.data?.dcId}/cancel`, { reason: 'test: lorry did not come' })
    const c4Now = await call('GET', `/fg-cartons/scan/${c4.body?.data?.code}`)
    check('challan cancelled: the carton sealed in the store, off it', cancelled.status === 200 && c4Now.body?.data?.status === 'PACKED' && !c4Now.body?.data?.challan, c4Now.body?.data && { s: c4Now.body.data.status, dc: c4Now.body.data.challan })

    // 7. Loose pieces still leave on a typed challan.
    const typedOk = await call('POST', '/sales/challans', { soId, warehouseId: store.id, dispatch: true, lines: [{ soLineId: soLine, sizes: [{ sizeId: s2.id, qty: 5 }] }] })
    check('loose pieces on a typed challan: sent', typedOk.status === 201, typedOk.body)
    const typedTooMany = await call('POST', '/sales/challans', { soId, warehouseId: store.id, dispatch: true, lines: [{ soLineId: soLine, sizes: [{ sizeId: s2.id, qty: 7 }] }] })
    check('but not into the sealed 4: 6 loose, 7 asked', typedTooMany.status === 400 && typedTooMany.body?.code === 'PACKED_IN_CARTONS' && /Only 6 pcs/.test(typedTooMany.body?.message ?? ''), typedTooMany.body)

    // 8. Its sticker: the buyer, the order and what is in it.
    const labels = await call('GET', `/fg-cartons/labels?ids=${c4.body?.data?.id}`)
    const l0 = labels.body?.data?.cartons?.[0]
    check('sticker data: order, buyer, item and sizes', l0?.order?.soNumber && l0?.order?.customer && l0?.items?.[0]?.code === item.code && l0?.items?.[0]?.sizes?.[0]?.qty === 4 && l0?.pieces === 4, l0)
    const list = await call('GET', `/fg-cartons?q=${encodeURIComponent(item.code)}&status=ALL`)
    check('the list finds the cartons by item: 4 of them', (list.body?.data ?? []).length === 4, (list.body?.data ?? []).map((c: any) => [c.code, c.status]))
  } finally {
    await prisma.style.update({ where: { id: st.id }, data: { isActive: st.isActive } })
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
