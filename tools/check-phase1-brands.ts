/**
 * Phase 1 of the multi-brand plan: brands told apart by the brand itself,
 * one brand per order, and the masters the rest builds on.
 *
 *   - a new own brand gets a code made from its name, and a profit centre with
 *     that code and the name given; a code already taken is refused;
 *   - the default brand moves in one step, and is never left unset or switched off;
 *   - an order, a quotation and a direct MO each carry one brand: a line of
 *     another own brand's style is refused, job work goes under the default;
 *   - with no brand picked, the brand every style belongs to is suggested;
 *   - style codes start with the brand's code; the Styles list filters by brand;
 *   - departments roll up into a parent, never into themselves; the plan's
 *     cost centres are set up in one go, and again changes nothing;
 *   - a process floor stays work in progress; another store takes a kind;
 *   - customers' brands are not P&L columns unless something was booked to them.
 *
 * Uses made-up ZZTEST brands, styles and the ZZTEST customer, never VHAGAR's.
 * Runs against a running API and the demo database (lderp_demo) only. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-phase1-brands.ts
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5105/api').replace(/\/+$/, '')
let pass = 0
let fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 500)}` : ''}`)
}
type Res = { status: number; body: any }
let token = ''
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let j: any = null
  try {
    j = await r.json()
  } catch {}
  return { status: r.status, body: j }
}
const okay = (r: Res) => r.status >= 200 && r.status < 300

async function main() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) {
    console.error('Set E2E_EMAIL and E2E_PASSWORD.')
    process.exitCode = 2
    return
  }
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== 'lderp_demo') {
    console.error('Refusing to run: not lderp_demo.')
    process.exitCode = 2
    return
  }
  token = (
    await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())
  ).accessToken
  if (!token) throw new Error('login failed')
  const stamp = Date.now().toString(36).slice(-5).toUpperCase()

  const madeBrands: string[] = []
  const madeStyles: string[] = []
  const madeItems: string[] = []
  const madeDepts: string[] = []
  const madeQuotes: string[] = []
  const original = await prisma.brand.findFirst({ where: { isDefault: true }, select: { id: true, name: true } })
  try {
    // ── Brands: code, profit centre, uniqueness ──
    const a = await call('POST', '/masters/brands', { name: `ZZTEST Alpha ${stamp}`, type: 'LD_COTTON_MILLS', isActive: true, profitCentreName: `ZZTEST Alpha PC ${stamp}` })
    const b = await call('POST', '/masters/brands', { name: `ZZTEST Beta ${stamp}`, type: 'LD_COTTON_MILLS', isActive: true })
    check('setup: two own test brands', okay(a) && okay(b), [a.body?.message, b.body?.message])
    if (!okay(a) || !okay(b)) return
    const A = a.body.data
    const B = b.body.data
    madeBrands.push(A.id, B.id)
    check('a new brand gets a code made from its name', typeof A.code === 'string' && A.code.startsWith('ZZ'), A.code)
    const centreA = await prisma.costCentre.findUnique({ where: { brandId: A.id }, select: { name: true, code: true } })
    check('its profit centre is made, with its code and the name given', centreA?.code === A.code && centreA?.name === `ZZTEST Alpha PC ${stamp}`, centreA)
    const centreB = await prisma.costCentre.findUnique({ where: { brandId: B.id }, select: { name: true } })
    check('no profit centre name given: the brand name', centreB?.name === `ZZTEST Beta ${stamp}`, centreB)
    const dup = await call('POST', '/masters/brands', { name: `ZZTEST Gamma ${stamp}`, type: 'LD_COTTON_MILLS', isActive: true, code: A.code })
    check('a code already taken is refused, on the Code box', dup.status === 400 && dup.body?.errors?.[0]?.path?.[0] === 'code', [dup.status, dup.body?.errors ?? dup.body?.message])
    if (okay(dup)) madeBrands.push(dup.body.data.id)
    const recode = await call('PATCH', `/masters/brands/${A.id}`, { code: `Z${stamp}`.slice(0, 8) })
    const centreA2 = await prisma.costCentre.findUnique({ where: { brandId: A.id }, select: { code: true } })
    check("a brand's new code: its profit centre follows", okay(recode) && centreA2?.code === `Z${stamp}`.slice(0, 8), [recode.body?.message, centreA2])
    const codeA = `Z${stamp}`.slice(0, 8)
    const cust = await call('POST', '/masters/brands', { name: `ZZTEST Client ${stamp}`, type: 'CUSTOM', isActive: true })
    if (okay(cust)) madeBrands.push(cust.body.data.id)
    const custCentre = okay(cust) ? await prisma.costCentre.findUnique({ where: { brandId: cust.body.data.id } }) : null
    check("a customer's brand gets no profit centre", okay(cust) && !custCentre, custCentre)

    // ── The default brand ──
    const toA = await call('PATCH', `/masters/brands/${A.id}`, { isDefault: true })
    const defaults = await prisma.brand.findMany({ where: { isDefault: true }, select: { id: true } })
    check('the default moves in one step: only the new one is default', okay(toA) && defaults.length === 1 && defaults[0].id === A.id, [toA.body?.message, defaults])
    const unset = await call('PATCH', `/masters/brands/${A.id}`, { isDefault: false })
    check('the default cannot simply be unticked', unset.status === 409, [unset.status, unset.body?.message])
    const off = await call('PATCH', `/masters/brands/${A.id}`, { isActive: false })
    check('the default cannot be switched off', off.status === 409, [off.status, off.body?.message])
    if (original) {
      const back = await call('PATCH', `/masters/brands/${original.id}`, { isDefault: true })
      check(`the default goes back to ${original.name}`, okay(back) && (await prisma.brand.findUnique({ where: { id: original.id } }))?.isDefault === true, back.body?.message)
    }

    // A fresh install has no default: the LD Cotton Mills brand takes it when added.
    await prisma.brand.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
    const fresh = await call('POST', '/masters/brands', { name: `ZZTEST LD Cotton ${stamp}`, type: 'LD_COTTON_MILLS', isActive: true })
    if (okay(fresh)) madeBrands.push(fresh.body.data.id)
    const freshRow = okay(fresh) ? await prisma.brand.findUnique({ where: { id: fresh.body.data.id }, select: { isDefault: true } }) : null
    check('no default yet: an LD Cotton Mills brand takes it when added', freshRow?.isDefault === true, [fresh.body?.message, freshRow])
    if (original) {
      await prisma.brand.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
      await prisma.brand.update({ where: { id: original.id }, data: { isDefault: true } })
    }

    // ── Styles of each brand (fixtures copied from the ZZTEST shirt) ──
    const base = await prisma.style.findFirstOrThrow({ where: { code: 'ZZTEST-SH-01' } })
    const baseItem = await prisma.item.findFirstOrThrow({ where: { styleId: base.id, type: 'FINISHED_GOOD' } })
    const makeStyle = async (brandId: string, tag: string) => {
      const st = await prisma.style.create({
        data: { code: `ZZTEST-P1${tag}-${stamp}`, name: `ZZTEST P1 ${tag} ${stamp}`, brandId, brandType: 'LD_COTTON_MILLS', sizeGroupId: base.sizeGroupId, colors: ['Navy'], stage: 'PRODUCTION', isActive: true },
      })
      madeStyles.push(st.id)
      const it = await prisma.item.create({
        data: { code: `ZZP1${tag}${stamp}`, name: `ZZTEST P1 ${tag} ${stamp} — Navy`, type: 'FINISHED_GOOD', categoryId: baseItem.categoryId, uomId: baseItem.uomId, hsnCode: '6205', styleId: st.id, color: 'Navy', isActive: true },
      })
      madeItems.push(it.id)
      return { st, it }
    }
    const sa = await makeStyle(A.id, 'A')
    const sb = await makeStyle(B.id, 'B')
    const customer = await prisma.customer.findFirstOrThrow({ where: { name: { startsWith: 'ZZTEST' }, isActive: true }, select: { id: true } })
    const sizes = await prisma.size.findMany({ where: { sizeGroupId: base.sizeGroupId! }, orderBy: { sequence: 'asc' }, take: 1, select: { id: true } })
    const line = (itemId: string) => ({ itemId, totalQty: 5, unitPrice: 100, sizes: [{ sizeId: sizes[0].id, qty: 5 }] })

    // ── One brand per order ──
    const mixed = await call('POST', '/sales/orders', { customerId: customer.id, brandId: A.id, isJobWork: false, lines: [line(sa.it.id), line(sb.it.id)] })
    check('an order mixing two own brands is refused', mixed.status === 400 && mixed.body?.code === 'BRAND_MIX', [mixed.status, mixed.body?.message])
    const jw = await call('POST', '/sales/orders', { customerId: customer.id, brandId: A.id, isJobWork: true, lines: [line(sa.it.id)] })
    check('job work under another brand than the default is refused', jw.status === 400 && jw.body?.code === 'JOB_WORK_BRAND', [jw.status, jw.body?.message])
    const qMixed = await call('POST', '/sales/quotations', { customerId: customer.id, brandId: B.id, lines: [{ itemId: sa.it.id, qty: 5, unitPrice: 100 }] })
    check("a quotation under one brand with another's style is refused", qMixed.status === 400 && qMixed.body?.code === 'BRAND_MIX', [qMixed.status, qMixed.body?.message])
    const qPlain = await call('POST', '/sales/quotations', { customerId: customer.id, lines: [{ itemId: sb.it.id, qty: 5, unitPrice: 100 }] })
    if (okay(qPlain)) madeQuotes.push(qPlain.body.data.id)
    check('no brand picked: the brand every style belongs to', okay(qPlain) && qPlain.body?.data?.brandId === B.id, [qPlain.status, qPlain.body?.message, qPlain.body?.data?.brandId])

    const moMixed = await call('POST', '/production/orders', {
      brandId: A.id,
      purpose: 'STOCK',
      lines: [{ styleId: sb.st.id, color: 'Navy', sizes: [{ sizeId: sizes[0].id, qty: 5 }] }],
    })
    check("a direct MO under one brand with another's style is refused", moMixed.status === 400 && moMixed.body?.code === 'BRAND_MIX', [moMixed.status, moMixed.body?.message])
    if (okay(moMixed)) await prisma.manufacturingOrder.delete({ where: { id: moMixed.body.data.id } }).catch(() => undefined)

    // ── Styles: filter by brand, codes start with the brand's code ──
    const listA = (await call('GET', `/masters/styles?brandId=${A.id}&limit=50`)).body?.data ?? []
    check('the Styles list filters by the brand itself', listA.length >= 1 && listA.every((x: any) => x.brandId === A.id), listA.map((x: any) => x.code))
    const next = await call('GET', `/masters/styles/next-code?brandId=${A.id}&category=Shirt`)
    check("a new style's code starts with its brand's code", okay(next) && String(next.body?.data?.code ?? '').startsWith(`${codeA}-`), next.body?.data)
    const qStyles = (await call('GET', '/sales/quotations/styles')).body?.data ?? []
    check("the quotation's style picker knows each style's brand", qStyles.some((x: any) => x.id === sa.st.id && x.brandId === A.id && x.brand?.name), qStyles.find((x: any) => x.id === sa.st.id))

    // ── Departments roll up ──
    const top = await call('POST', '/masters/departments', { name: `ZZTEST Top ${stamp}`, isActive: true })
    const low = await call('POST', '/masters/departments', { name: `ZZTEST Low ${stamp}`, isActive: true })
    if (okay(top)) madeDepts.push(top.body.data.id)
    if (okay(low)) madeDepts.push(low.body.data.id)
    const under = await call('PATCH', `/masters/departments/${low.body?.data?.id}`, { parentId: top.body?.data?.id })
    check('a department rolls up into another', okay(under) && under.body?.data?.parentId === top.body?.data?.id, under.body?.message)
    const loop = await call('PATCH', `/masters/departments/${top.body?.data?.id}`, { parentId: low.body?.data?.id })
    check('…never into one that rolls up into it', loop.status === 400 && loop.body?.code === 'PARENT_LOOP', [loop.status, loop.body?.message])
    const self = await call('PATCH', `/masters/departments/${top.body?.data?.id}`, { parentId: top.body?.data?.id })
    check('…nor into itself', self.status === 400 && self.body?.code === 'PARENT_LOOP', [self.status, self.body?.message])
    const s1 = await call('POST', '/masters/departments/standard-cost-centres', {})
    const qc = await prisma.department.findFirst({ where: { name: 'Quality Control' }, select: { id: true, parent: { select: { name: true } } } })
    const lineQc = await prisma.department.findFirst({ where: { name: 'Line QC' }, select: { parentId: true } })
    check("the plan's cost centres are set up: Quality Control under Production", okay(s1) && qc?.parent?.name === 'Production', [s1.body?.message, qc])
    check('…and Line QC under Quality Control', !lineQc || lineQc.parentId === qc?.id, lineQc)
    const before = await prisma.department.count()
    const s2 = await call('POST', '/masters/departments/standard-cost-centres', {})
    check('set up again: nothing added', okay(s2) && (await prisma.department.count()) === before, s2.body?.message)

    // ── Store kinds ──
    const floor = await prisma.warehouse.findFirst({ where: { departmentId: { not: null } }, select: { id: true, kind: true } })
    check('a process floor is work in progress', !floor || floor.kind === 'WIP', floor)
    if (floor) {
      const bad = await call('PATCH', `/masters/warehouses/${floor.id}`, { kind: 'GENERAL' })
      check('…and stays so', bad.status === 400 && bad.body?.code === 'FLOOR_KIND', [bad.status, bad.body?.message])
    }
    const store = await call('POST', '/masters/warehouses', { name: `ZZTEST Reject Store ${stamp}`, kind: 'REJECTED', isActive: true })
    check('another store takes a kind', okay(store) && store.body?.data?.kind === 'REJECTED', store.body?.message ?? store.body?.data)
    if (okay(store)) await call('PATCH', `/masters/warehouses/${store.body.data.id}`, { isActive: false })

    // ── Accounts: customers' brands ──
    const centres = (await call('GET', '/accounts/cost-centres')).body?.data ?? []
    check("the voucher's Brand box can tell a customer's brand apart", centres.length > 0 && centres.every((c: any) => !c.brand || 'type' in c.brand), centres.slice(0, 2))
    const pl = await call('GET', '/accounts/profit-loss')
    const custIds = new Set(centres.filter((c: any) => c.brand?.type === 'CUSTOM').map((c: any) => c.id))
    const cols = (pl.body?.data?.brand ?? []) as Array<{ id: string; grossProfit: number; netProfit: number }>
    const emptyCustomerCols = cols.filter((c) => custIds.has(c.id) && c.grossProfit === 0 && c.netProfit === 0)
    check("P&L by brand: no empty column for a customer's brand", okay(pl) && emptyCustomerCols.length === 0, [pl.status, emptyCustomerCols])
  } finally {
    if (original) await prisma.brand.updateMany({ where: { isDefault: true, id: { not: original.id } }, data: { isDefault: false } })
    if (original) await prisma.brand.update({ where: { id: original.id }, data: { isDefault: true } })
    for (const id of madeQuotes) {
      await prisma.$transaction(async (tx) => {
        await tx.salesQuotationLine.deleteMany({ where: { quoteId: id } })
        await tx.salesQuotationCharge.deleteMany({ where: { quoteId: id } })
        await tx.salesQuotation.delete({ where: { id } })
      }).catch((e) => console.log(`clean-up: quotation ${id} kept (${(e as Error).message.slice(0, 80)})`))
    }
    await prisma.item.updateMany({ where: { id: { in: madeItems } }, data: { isActive: false } })
    await prisma.style.updateMany({ where: { id: { in: madeStyles } }, data: { isActive: false } })
    await prisma.department.updateMany({ where: { id: { in: madeDepts } }, data: { isActive: false, parentId: null } })
    await prisma.brand.updateMany({ where: { id: { in: madeBrands } }, data: { isActive: false } })
    await prisma.costCentre.updateMany({ where: { brandId: { in: madeBrands } }, data: { isActive: false } })
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
