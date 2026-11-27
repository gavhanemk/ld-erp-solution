/**
 * Checks an order's brand from start to end: picked on the quotation and the
 * sales order (an in-house brand only), carried to its manufacturing order,
 * moved with it when the order's brand changes, and handed to every print and
 * list of the stages after — against a running API and the demo database
 * (lderp_demo) only. Refuses any other database. Uses the ZZTEST style and
 * customer, never VHAGAR's, and a brand of this run's own. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-order-brand.ts
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

  // 1. Brands of this run's own: one in-house, one a customer's.
  const own = await call('POST', '/masters/brands', { name: `ZZTEST Own ${stamp}`, type: 'LD_COTTON_MILLS', isActive: true })
  const cust = await call('POST', '/masters/brands', { name: `ZZTEST Cust ${stamp}`, type: 'CUSTOM', isActive: true })
  check('setup: an in-house brand and a customer brand', okay(own) && okay(cust), [own.body, cust.body])
  const ownId = own.body.data.id as string
  const inHouse = (await call('GET', '/masters/brands?active=true&type=LD_COTTON_MILLS,VHAGAR&limit=100')).body?.data ?? []
  check("the Brand box's list: in-house brands only", inHouse.some((b: any) => b.id === ownId) && !inHouse.some((b: any) => b.id === cust.body.data.id), inHouse.map((b: any) => b.name))
  const ldMain = await prisma.brand.findFirstOrThrow({ where: { isDefault: true }, select: { id: true, name: true } })

  // The ZZTEST style's item and customer (never VHAGAR's).
  const st = await prisma.style.findFirstOrThrow({ where: { code: 'ZZTEST-SH-01' }, select: { id: true, isActive: true, sizeGroupId: true, brandId: true, brandType: true } })
  const wasActive = st.isActive
  // For this run the shirt carries the customer's label: an order may then go
  // under any of our brands (one brand per order binds only our own brands'
  // styles — see check-phase1-brands.ts). Put back at the end.
  await prisma.style.update({ where: { id: st.id }, data: { isActive: true, brandId: cust.body.data.id, brandType: 'CUSTOM' } })
  try {
    const item = await prisma.item.findFirstOrThrow({ where: { styleId: st.id, type: 'FINISHED_GOOD', isActive: true }, select: { id: true, hsnCode: true } })
    if (!item.hsnCode) await prisma.item.update({ where: { id: item.id }, data: { hsnCode: '6205' } })
    const customer = await prisma.customer.findFirstOrThrow({ where: { name: { startsWith: 'ZZTEST' }, isActive: true }, select: { id: true } })
    const sizes = await prisma.size.findMany({ where: { sizeGroupId: st.sizeGroupId! }, orderBy: { sequence: 'asc' }, take: 2, select: { id: true } })

    // 2. The quotation: a customer's brand refused; an in-house one kept; none, the styles'.
    const quoteLine = { itemId: item.id, qty: 20, unitPrice: 250 }
    const custQuote = await call('POST', '/sales/quotations', { customerId: customer.id, brandId: cust.body.data.id, lines: [quoteLine] })
    check("a quotation under a customer's brand: refused", custQuote.status === 400 && custQuote.body?.code === 'NOT_OWN_BRAND', custQuote.body)
    const quote = await call('POST', '/sales/quotations', { customerId: customer.id, brandId: ownId, lines: [quoteLine] })
    check('a quotation under the picked in-house brand', okay(quote) && quote.body?.data?.brandId === ownId, quote.body?.data?.brandId ?? quote.body)
    const plain = await call('POST', '/sales/quotations', { customerId: customer.id, lines: [quoteLine] })
    const plainBrand = plain.body?.data?.brandId ? await prisma.brand.findUnique({ where: { id: plain.body.data.brandId }, select: { type: true } }) : null
    check("no brand picked: a customer's label goes under the default brand", okay(plain) && plain.body?.data?.brandId === ldMain.id, plain.body?.data?.brandId)

    // 3. The sales order under it, confirmed.
    const so = await call('POST', '/sales/orders', {
      customerId: customer.id,
      brandId: ownId,
      isJobWork: false,
      customerPORef: `ZZ-BR-${stamp}`,
      confirm: true,
      creditReleaseReason: 'Demo test order',
      lines: [{ itemId: item.id, totalQty: 20, unitPrice: 250, sizes: [{ sizeId: sizes[0].id, qty: 12 }, { sizeId: sizes[1].id, qty: 8 }] }],
    })
    const soId = so.body?.data?.id
    check('a sales order under the picked brand, confirmed', so.status === 201 && so.body?.data?.brandId === ownId, so.body?.message ?? so.body)
    const custSo = await call('POST', '/sales/orders', { customerId: customer.id, brandId: cust.body.data.id, lines: [{ itemId: item.id, totalQty: 1, unitPrice: 1, sizes: [{ sizeId: sizes[0].id, qty: 1 }] }] })
    check("a sales order under a customer's brand: refused", custSo.status === 400 && custSo.body?.code === 'NOT_OWN_BRAND', custSo.body)

    // 4. Its manufacturing order carries it.
    const soLine = await prisma.salesOrderLine.findFirstOrThrow({ where: { soId }, select: { id: true } })
    const mo = await call('POST', '/production/orders', { soId, lines: [{ soLineId: soLine.id, sizes: [{ sizeId: sizes[0].id, qty: 12 }, { sizeId: sizes[1].id, qty: 8 }] }] })
    const moId = mo.body?.data?.id
    const moRow = moId ? await prisma.manufacturingOrder.findUnique({ where: { id: moId }, select: { brandId: true } }) : null
    check('its manufacturing order is under the same brand', okay(mo) && moRow?.brandId === ownId, mo.body?.message ?? mo.body)

    // 5. The order's brand changed: the manufacturing order goes with it.
    const saved = (await call('GET', `/sales/orders/${soId}`)).body?.data
    const amend = await call('POST', `/sales/orders/${soId}/amend`, {
      customerId: saved.customerId,
      brandId: ldMain.id,
      isJobWork: false,
      customerPORef: saved.customerPORef,
      reason: 'Test: the brand changes',
      lines: saved.lines.map((l: any) => ({
        id: l.id,
        itemId: l.itemId,
        totalQty: Number(l.totalQty),
        unitPrice: Number(l.unitPrice),
        sizes: (l.sizes ?? []).map((z: any) => ({ sizeId: z.sizeId, qty: Number(z.qty) })),
      })),
    })
    const moAfter = moId ? await prisma.manufacturingOrder.findUnique({ where: { id: moId }, select: { brandId: true } }) : null
    check(`the order moved to ${ldMain.name}: its manufacturing order too`, okay(amend) && moAfter?.brandId === ldMain.id, amend.body?.message ?? amend.body)

    // 6. Every print and list of the stages after carries the order's brand.
    const expect = async (what: string, path: string, brandOf: () => Promise<{ name: string } | null | undefined>) => {
      const r = await call('GET', path)
      const want = await brandOf()
      check(`${what}: its order's brand`, okay(r) && !!want && r.body?.data?.brand?.name === want.name, { got: r.body?.data?.brand, want })
    }
    const dc = await prisma.deliveryChallan.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true, so: { select: { brand: { select: { name: true } } } } } })
    if (dc) await expect('challan print', `/sales/challans/${dc.id}/print`, async () => dc.so.brand)
    const inv = await prisma.salesInvoice.findFirst({ where: { soId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, so: { select: { brand: { select: { name: true } } } } } })
    if (inv) await expect('invoice print', `/sales/invoices/${inv.id}/print`, async () => inv.so?.brand)
    const cn = await prisma.creditNote.findFirst({ where: { invoice: { soId: { not: null } } }, orderBy: { createdAt: 'desc' }, select: { id: true, invoice: { select: { so: { select: { brand: { select: { name: true } } } } } } } })
    if (cn) await expect('credit note print', `/sales/credit-notes/${cn.id}/print`, async () => cn.invoice?.so?.brand)
    const cut = await prisma.cuttingOrder.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true, mo: { select: { brand: { select: { name: true } } } } } })
    if (cut) await expect('cutting sheet print', `/production/cutting/${cut.id}/print`, async () => cut.mo.brand)
    const card = await prisma.jobCard.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true, mo: { select: { brand: { select: { name: true } } } } } })
    if (card) await expect('job card print', `/production/job-cards/${card.id}/print`, async () => card.mo.brand)
    const pt = await prisma.processTransfer.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true, mo: { select: { brand: { select: { name: true } } } } } })
    if (pt) await expect('process transfer print', `/production/transfers/${pt.id}/print`, async () => pt.mo.brand)
    const mr = await prisma.materialRequisition.findFirst({ where: { moId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, mo: { select: { brand: { select: { name: true } } } } } })
    if (mr) await expect('requisition print', `/inventory/requisitions/${mr.id}/print`, async () => mr.mo?.brand)

    const dcList = (await call('GET', '/sales/challans?limit=5')).body?.data ?? []
    check('challan list: each with its order\'s brand', dcList.length > 0 && dcList.every((c: any) => c.so?.brand?.name), dcList.map((c: any) => c.so?.brand))
    const invList = (await call('GET', '/sales/invoices?limit=5')).body?.data ?? []
    check('invoice list: each with its order\'s brand', invList.length > 0 && invList.filter((i: any) => i.so).every((i: any) => i.so.brand?.name), invList.map((i: any) => i.so?.brand))
    const moList = (await call('GET', `/production/orders?soId=${soId}`)).body?.data ?? []
    check('manufacturing order list: the brand', moList.some((m: any) => m.id === moId && m.brand?.id === ldMain.id), moList.map((m: any) => m.brand))
    const trace = await call('GET', `/trace/order/SO/${soId}`)
    const traceSo = trace.body?.data?.so
    if (okay(trace)) check('Track & Trace: the order with its brand', traceSo?.brand?.name === ldMain.name, traceSo?.brand)
    else console.log(`SKIP  Track & Trace: ${trace.status} on /trace/order`)
  } finally {
    await prisma.style.update({ where: { id: st.id }, data: { isActive: wasActive, brandId: st.brandId, brandType: st.brandType } })
    // This run's brands are switched off, not left in the lists.
    await call('PATCH', `/masters/brands/${ownId}`, { isActive: false })
    await call('PATCH', `/masters/brands/${cust.body?.data?.id}`, { isActive: false })
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
