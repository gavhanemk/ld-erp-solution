// The final user-acceptance walk for the multi-brand ERP (28 Nov 2026), run on the demo and KEPT there
// for the user to follow screen by screen. Unlike the checks, nothing is rolled back: every document
// stays, ZZTEST-named and stamped.
//
// Three own brands: LD Cotton Mills, Stich Code, and ZZTEST UAT Brand standing in for the third (tests
// never use VHAGAR). A month of shared expenses split between them (September 2026: rent and power paid,
// the allocation worked out, approved and posted), and this month's trade:
//
//   1. a shared purchase (no brand: central) and a brand's own purchase (Stich Code), each billed, and
//      part of the brand's purchase returned;
//   2. a store transfer of central fabric, sent and received;
//   3. production on LD Cotton Mills: the order, its MO, fabric issued within the plan (central stock
//      moving to the brand by itself, decision 7), finished goods in on the brand;
//   4. dispatch: Stich Code's order sent from free central stock (moved to it on the challan),
//      ZZTEST UAT Brand's from pieces LD Cotton Mills moved to it (an internal transfer at value),
//      LD Cotton Mills' from its own; each invoiced; part of LD's sent back on a credit note;
//   5. everything brought into the books, then September's and November's P&L by brand, the stock
//      reconciliation and the brand-share figures checked.
//
// Demo database (lderp_demo) only; the API at E2E_API with the admin's E2E_EMAIL / E2E_PASSWORD.
// From apps/api:
//
//   npx tsx ../../tools/uat-multibrand.ts
import { prisma } from '../packages/database/src/index'
import { issueRequisition } from '../apps/api/src/routes/inventory.routes'
import { approveReallocation, raiseReallocation } from '../apps/api/src/services/brandStock.service'
import { balanceOf, recordMovement } from '../apps/api/src/services/stock.service'
import { profitAndLoss } from '../apps/api/src/services/accounts/finalAccounts.service'
import { booksSettings, dayValue, todayIst } from '../apps/api/src/services/accounts/books.service'
import { departmentNamed, postPending } from '../apps/api/src/services/accounts/posting.service'
import { stockReconciliation } from '../apps/api/src/reports/definitions/stock-reconciliation'
import { checksCustomer } from './test-orders'

const API = process.env.E2E_API ?? 'http://localhost:5105/api'
let token = ''
type Res = { status: number; body: any }
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  let j: any = null
  try {
    j = await r.json()
  } catch {}
  return { status: r.status, body: j }
}
const okay = (r: Res) => r.status >= 200 && r.status < 300
let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 700)}` : ''}`)
}
const step = (n: string, what: string) => console.log(`\n── ${n}. ${what}`)
/** A document the walk needs: stop with what the API said when it is refused. */
const must = (r: Res, what: string) => {
  if (!okay(r)) throw new Error(`${what}: ${r.status} ${r.body?.code ?? ''} ${r.body?.message ?? JSON.stringify(r.body?.errors ?? r.body)}`)
  return r.body.data
}
const r2 = (n: number) => Math.round(n * 100) / 100
const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol
const stamp = Date.now().toString(36).slice(-5).toUpperCase()
const kept: string[] = []

async function main() {
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== 'lderp_demo') throw new Error('Refusing to run: not lderp_demo.')
  const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD }) }).then((r) => r.json())
  token = (login.data ?? login).accessToken
  if (!token) throw new Error('Sign-in refused: set E2E_EMAIL and E2E_PASSWORD to the demo admin')
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: process.env.E2E_EMAIL! }, select: { id: true, name: true } })
  // Whoever approves what the admin raises: another active person.
  const other = await prisma.user.findFirstOrThrow({ where: { status: 'ACTIVE', id: { not: admin.id }, email: { startsWith: 'zztest.' } }, select: { id: true, name: true } })
  const asAdmin = { id: admin.id, email: '', name: admin.name, roleId: '', role: 'Super Admin', superAdmin: true, permissions: [] } as never
  const company = await prisma.company.findFirstOrThrow({ select: { id: true } })
  const today = todayIst()

  // ═══ Masters: three own brands, ZZTEST stores and items ═══
  step('0', 'Masters')
  const LD = await prisma.brand.findFirstOrThrow({ where: { isActive: true, isDefault: true }, select: { id: true, name: true, costCentre: { select: { id: true } } } })
  const SC = await prisma.brand.findFirstOrThrow({ where: { isActive: true, name: 'Stich Code' }, select: { id: true, name: true, costCentre: { select: { id: true } } } })
  const C =
    (await prisma.brand.findFirst({ where: { name: 'ZZTEST UAT Brand' }, select: { id: true, name: true } })) ??
    (await prisma.brand.create({ data: { companyId: company.id, name: 'ZZTEST UAT Brand', type: 'LD_COTTON_MILLS' }, select: { id: true, name: true } }))
  const cCentre = (await prisma.costCentre.findFirst({ where: { brandId: C.id }, select: { id: true } })) ?? (await prisma.costCentre.create({ data: { name: 'ZZTEST UAT Brand', brandId: C.id }, select: { id: true } }))
  if (!LD.costCentre || !SC.costCentre) throw new Error('LD Cotton Mills and Stich Code need their profit centres (open Accounts once)')
  const centre = { [LD.id]: LD.costCentre.id, [SC.id]: SC.costCentre.id, [C.id]: cCentre.id }
  const store = async (name: string, code: string, kind: 'GENERAL' | 'FINISHED_GOODS') =>
    (await prisma.warehouse.findFirst({ where: { name }, select: { id: true } }))?.id ?? (await prisma.warehouse.create({ data: { companyId: company.id, name, code, kind }, select: { id: true } })).id
  const F1 = await store('ZZTEST UAT Fabric', 'ZZUATF1', 'GENERAL')
  const F2 = await store('ZZTEST UAT Fabric 2', 'ZZUATF2', 'GENERAL')
  const FG = await store('ZZTEST UAT FG', 'ZZUATFG', 'FINISHED_GOODS')
  const fabricTemplate = await prisma.item.findUniqueOrThrow({ where: { code: 'FAB-COT-001' } })
  const fgTemplate = await prisma.item.findUniqueOrThrow({ where: { code: 'FG-SHRT-001' } })
  // Fabric of a category not kept on stickers, so the walk stays on brands rather than roll picking.
  const untracked = await prisma.itemCategory.findFirst({ where: { trackPackages: false, isActive: true, items: { some: { type: 'RAW_MATERIAL' } } }, select: { id: true } })
  const fabric = await prisma.item.create({
    data: { code: `ZZUF${stamp}`, name: `ZZTEST UAT fabric ${stamp}`, type: 'RAW_MATERIAL', categoryId: untracked?.id ?? fabricTemplate.categoryId, uomId: fabricTemplate.uomId, hsnCode: fabricTemplate.hsnCode, standardRate: 100 },
    select: { id: true, code: true },
  })
  const style = await prisma.style.findUniqueOrThrow({ where: { code: 'LD-SH-2601' }, include: { sizeGroup: { include: { sizes: true } } } })
  const color = `ZZ UAT ${stamp}`
  await prisma.style.update({ where: { id: style.id }, data: { colors: { push: color } } })
  const taxRateId = fgTemplate.taxRateId ?? (await prisma.taxRate.findFirstOrThrow({ where: { rate: 5 } })).id
  const fg = await prisma.item.create({
    data: { code: `ZZUG${stamp}`, name: `ZZTEST UAT shirt ${stamp}`, type: 'FINISHED_GOOD', categoryId: fgTemplate.categoryId, uomId: fgTemplate.uomId, styleId: style.id, color, standardRate: 250, hsnCode: fgTemplate.hsnCode ?? '6205', taxRateId },
    select: { id: true, code: true },
  })
  // A plain shirt of no style, sold by the piece: any of our own brands may sell it (a style belongs to
  // one brand, and an order carries one brand, so the LD style above is sold only by LD Cotton Mills).
  const plain = await prisma.item.create({
    data: { code: `ZZUP${stamp}`, name: `ZZTEST UAT plain shirt ${stamp}`, type: 'FINISHED_GOOD', categoryId: fgTemplate.categoryId, uomId: fgTemplate.uomId, standardRate: 250, hsnCode: fgTemplate.hsnCode ?? '6205', taxRateId },
    select: { id: true, code: true },
  })
  kept.push(fabric.id, fg.id, plain.id)
  const cutting = await prisma.department.findFirstOrThrow({ where: { name: 'Cutting' }, select: { id: true } })
  await prisma.bOM.create({
    data: { styleId: style.id, color, version: '1.0', status: 'APPROVED', approvedById: admin.id, approvedAt: new Date(), lines: { create: [{ componentItemId: fabric.id, departmentId: cutting.id, qtyPerUnit: 1.5, effectiveQty: 1.5 }] } },
  })
  const [S1, S2] = [...style.sizeGroup!.sizes].sort((a, b) => a.sequence - b.sequence)
  const customer = await checksCustomer(prisma, call)
  const supplier = must(await call('GET', '/masters/suppliers?limit=5'), 'a supplier')[0]
  const share = (itemId: string, warehouseId: string, brandId: string | null, sizeId: string | null = null) => balanceOf(prisma, { itemId, warehouseId, ownership: 'OWNED', sizeId, grade: 'A', brandId })
  console.log(`brands ${LD.name}, ${SC.name}, ${C.name}; stores ZZTEST UAT Fabric, Fabric 2, FG; items ${fabric.code}, ${fg.code} (${style.code}, ${color}); approver ${other.name}`)
  // The labels window after stock goes out by a form rather than a scan, as the store does it: the
  // rolls it suggests (its own share's, oldest first) are the ones that went.
  const labels = async (type: 'MR' | 'PURCHASE_RETURN' | 'TRANSFER', id: string, what: string, q?: string) => {
    const plan = must(await call('POST', '/packages/outward/plan', { type, id, ...(q ? { q } : {}) }), `${what}: its labels window`)
    const takes = (plan.spots ?? []).flatMap((s: any) => (s.packages ?? []).filter((p: any) => p.take > 0).map((p: any) => ({ packageId: p.id, qty: p.take })))
    if (takes.length) must(await call('POST', '/packages/outward/apply', { type, id, ...(q ? { q } : {}), takes }), `${what}: its stickers`)
    return takes.length
  }

  // ═══ 1. Purchases: one shared, one the brand's own; billed; part returned ═══
  step('1', 'Purchases')
  const buy = async (brandId: string | null, qty: number, tag: string) => {
    const po = must(await call('POST', '/purchase/orders', { supplierId: supplier.id, deliveryWarehouseId: F1, ...(brandId ? { brandId } : {}), notes: `ZZTEST UAT ${tag} ${stamp}`, lines: [{ itemId: fabric.id, qty, unitRate: 100, gstRate: 5 }] }), `the ${tag} PO`)
    await call('PATCH', `/purchase/orders/${po.id}/send`, {})
    const grn = must(await call('POST', '/purchase/grn', { poId: po.id, challanNo: `ZZ-UAT-${tag}-${stamp}`, challanDate: new Date().toISOString(), lines: [{ poLineId: po.lines[0].id, warehouseId: F1, receivedQty: qty }] }), `the ${tag} GRN`)
    const grnLine = await prisma.gRNLine.findFirstOrThrow({ where: { grnId: grn.id }, select: { id: true, brandId: true } })
    const bill = must(
      await call('POST', '/purchase/bills', { supplierId: supplier.id, supplierInvoiceNo: `ZZ-UAT-${tag}-${stamp}`, supplierInvoiceDate: new Date().toISOString(), lines: [{ itemId: fabric.id, grnLineId: grnLine.id, qty, unitPrice: 100, gstRate: 5 }] }),
      `the ${tag} bill`,
    )
    console.log(`${tag}: ${po.poNumber} → ${grn.grnNumber} → bill ${bill.billNumber ?? bill.id}`)
    return { po, grn, grnLine, bill }
  }
  const shared = await buy(null, 100, 'SHARED')
  check('the shared purchase (no brand on the PO, no indent, no style) is central stock: 100 m', shared.grnLine.brandId === null && (await share(fabric.id, F1, null)).qty === 100)
  const own = await buy(SC.id, 20, 'STICH')
  check(`${SC.name}'s own purchase is its share: 20 m`, own.grnLine.brandId === SC.id && (await share(fabric.id, F1, SC.id)).qty === 20)
  const billLine = own.bill.lines?.[0] ?? (await prisma.purchaseInvoiceLine.findFirstOrThrow({ where: { invoiceId: own.bill.id }, select: { id: true } }))
  const ret = must(
    await call('POST', '/purchase/returns', { billId: own.bill.id, returnDate: new Date().toISOString(), reasonNote: `ZZTEST UAT ${stamp}`, lines: [{ billLineId: billLine.id, warehouseId: F1, qty: 4, reason: 'QUALITY_REJECTION' }] }),
    'the purchase return',
  )
  check(`4 m returned from ${SC.name}'s purchase: out of its own share, central untouched (16 m and 100 m)`, (await share(fabric.id, F1, SC.id)).qty === 16 && (await share(fabric.id, F1, null)).qty === 100, ret?.returnNumber)
  check(`…its labels window takes the 4 m off ${SC.name}'s roll`, (await labels('PURCHASE_RETURN', ret.id, 'the return')) > 0)

  // ═══ 2. A store transfer of central fabric ═══
  step('2', 'Store transfer')
  const tr = must(await call('POST', '/inventory/transfers', { fromWarehouseId: F1, toWarehouseId: F2, lines: [{ itemId: fabric.id, qty: 10 }] }), 'the transfer')
  check(`${tr.transferNumber}: its labels window sends 10 m of the central roll with the goods`, (await labels('TRANSFER', tr.id, 'the transfer')) > 0)
  if (tr.status !== 'RECEIVED' && tr.lines?.length) must(await call('POST', `/inventory/transfers/${tr.id}/receive`, { lines: tr.lines.map((l: { id: string }) => ({ lineId: l.id, qty: 10 })) }), 'the transfer received')
  check('10 m of central fabric moved store to store: still central, 90 m and 10 m', (await share(fabric.id, F1, null)).qty === 90 && (await share(fabric.id, F2, null)).qty === 10, tr.transferNumber)

  // ═══ 3. Production on LD Cotton Mills ═══
  step('3', 'Production')
  const deliveryDate = new Date(Date.now() + 10 * 86_400_000).toISOString()
  const order = async (brandId: string, qty: Array<[string, number]>, price: number, tag: string) =>
    must(
      await call('POST', '/sales/orders', {
        customerId: customer.id,
        brandId,
        customerPORef: `ZZ-UAT-${tag}-${stamp}`,
        deliveryDate,
        confirm: true,
        lines: [{ itemId: fg.id, color, totalQty: qty.reduce((t, [, q]) => t + q, 0), unitPrice: price, sizes: qty.map(([sizeId, q]) => ({ sizeId, qty: q })) }],
      }),
      `the ${tag} order`,
    )
  const soA = await order(LD.id, [[S1.id, 10], [S2.id, 10]], 420, 'LD')
  check(`${soA.soNumber}: ${LD.name}'s order for 20, confirmed`, soA.brandId === LD.id && soA.status === 'CONFIRMED', soA.status)
  const mo = must(await call('POST', '/production/orders', { soId: soA.id, release: true, lines: [{ soLineId: soA.lines[0].id, sizes: [{ sizeId: S1.id, qty: 10 }, { sizeId: S2.id, qty: 10 }] }] }), 'the MO')
  check(`${mo.moNumber} released on ${LD.name}: 30 m of fabric on its plan`, mo.brandId === LD.id && mo.status === 'RELEASED')
  const mr = await prisma.materialRequisition.create({
    data: { mrNumber: `ZZ-UATMR-${stamp}`, moId: mo.id, soId: soA.id, departmentId: cutting.id, status: 'APPROVED', lines: { create: [{ itemId: fabric.id, requestedQty: 30, warehouseId: F1 }] } },
    include: { lines: true },
  })
  await prisma.$transaction((tx) => issueRequisition(tx, mr.id, { lines: [{ lineId: mr.lines[0].id, issueQty: 30, warehouseId: F1 }] }, asAdmin), { timeout: 60_000 })
  const auto = await prisma.stockReallocation.findFirst({ where: { mrId: mr.id, kind: 'AUTO' }, include: { lines: true } })
  check(`30 m issued within the plan: central stock moved to ${LD.name} by itself (decision 7), central now 60 m`, !!auto && auto.toBrandId === LD.id && Number(auto.lines[0]?.qty) === 30 && (await share(fabric.id, F1, null)).qty === 60, auto?.lines)
  check(`…its labels window takes the 30 m off the roll that moved to ${LD.name} with it`, (await labels('MR', mr.id, 'the issue', `${mr.lines[0].id}:30:${F1}`)) > 0)
  const fgr = must(await call('POST', '/finished-goods', { warehouseId: FG, moId: mo.id, notes: `ZZTEST UAT ${stamp}`, lines: [{ itemId: fg.id, sizeId: S1.id, qty: 10 }, { itemId: fg.id, sizeId: S2.id, qty: 10 }] }), 'the FG receipt')
  check(`${fgr.fgrNumber}: 20 shirts in on ${LD.name}'s share`, (await share(fg.id, FG, LD.id, S1.id)).qty === 10 && (await share(fg.id, FG, LD.id, S2.id)).qty === 10)

  // ═══ 4. Dispatch from the order's brand, from central, and after a brand-to-brand transfer ═══
  step('4', 'Dispatch, transfers between brands, returns')
  // Central stock of the plain shirt from before brands had shares, as the opening stock brings it in.
  await prisma.$transaction((tx) => recordMovement(tx, { itemId: plain.id, warehouseId: FG, transactionType: 'OPENING', direction: 'IN', qty: 20, unitRate: 250, referenceType: 'ZZTEST_OPENING', referenceId: `zzuat-${stamp}` }))
  const challan = async (so: { id: string; lines: Array<{ id: string }> }, line: { sizes?: Array<[string, number]>; qty?: number }, tag: string) =>
    must(
      await call('POST', '/sales/challans', {
        soId: so.id,
        warehouseId: FG,
        dispatch: true,
        transporter: 'ZZTEST Roadways',
        vehicleNumber: 'mh04zz0001',
        lrNumber: `LR-UAT-${tag}-${stamp}`,
        cartons: 1,
        lines: [{ soLineId: so.lines[0].id, ...(line.sizes ? { sizes: line.sizes.map(([sizeId, qty]) => ({ sizeId, qty })) } : { qty: line.qty }) }],
      }),
      `the ${tag} challan`,
    )
  const invoice = async (dc: { id: string }, tag: string) => must(await call('POST', '/sales/invoices', { dcId: dc.id }), `the ${tag} invoice`)
  const plainOrder = async (brandId: string, qty: number, price: number, tag: string) =>
    must(
      await call('POST', '/sales/orders', { customerId: customer.id, brandId, customerPORef: `ZZ-UAT-${tag}-${stamp}`, deliveryDate, confirm: true, lines: [{ itemId: plain.id, totalQty: qty, unitPrice: price }] }),
      `the ${tag} order`,
    )
  const approved = (input: Parameters<typeof raiseReallocation>[1]) =>
    prisma.$transaction(async (tx) => {
      const m = await raiseReallocation(tx, input, admin.id)
      await approveReallocation(tx, m.id, { id: other.id, admin: false })
      return m
    })

  // Stich Code's order: nothing of its own, so free central stock moves to it on the challan.
  const soB = await plainOrder(SC.id, 8, 450, 'STICH')
  const dcB = await challan(soB, { qty: 8 }, 'STICH')
  const autoB = await prisma.stockReallocation.findFirst({ where: { dcId: dcB.id, kind: 'AUTO' }, include: { lines: true } })
  check(`${dcB.dcNumber}: ${SC.name} has no plain shirts of its own, so 8 of the free central ones moved to it on the challan and went (central 12 left)`, !!autoB && autoB.toBrandId === SC.id && autoB.fromBrandId === null && Number(autoB.lines[0]?.qty) === 8 && (await share(plain.id, FG, null)).qty === 12, autoB)
  const invB = await invoice(dcB, 'STICH')

  // Central stock earmarked for Stich Code, then part of it handed to ZZTEST UAT Brand: two internal transfers.
  const ear = await approved({ kind: 'EARMARK', warehouseId: FG, fromBrandId: null, toBrandId: SC.id, reason: `ZZTEST UAT ${SC.name}'s next order ${stamp}`, lines: [{ itemId: plain.id, qty: 6 }] })
  const move = await approved({ kind: 'MOVE', warehouseId: FG, fromBrandId: SC.id, toBrandId: C.id, reason: `ZZTEST UAT ${C.name} short of shirts ${stamp}`, lines: [{ itemId: plain.id, qty: 5 }] })
  check(
    `${ear.number}: 6 central shirts earmarked for ${SC.name}; ${move.number}: 5 of them handed to ${C.name}, each approved by ${other.name} (central 6, ${SC.name} 1, ${C.name} 5)`,
    (await share(plain.id, FG, null)).qty === 6 && (await share(plain.id, FG, SC.id)).qty === 1 && (await share(plain.id, FG, C.id)).qty === 5,
  )
  const soC = await plainOrder(C.id, 5, 400, 'UAT')
  const dcC = await challan(soC, { qty: 5 }, 'UAT')
  check(`${dcC.dcNumber}: ${C.name}'s order sent from the shirts handed to it, none left; central's and ${SC.name}'s untouched`, (await share(plain.id, FG, C.id)).qty === 0 && (await share(plain.id, FG, null)).qty === 6 && (await share(plain.id, FG, SC.id)).qty === 1)
  const invC = await invoice(dcC, 'UAT')

  // LD Cotton Mills' order: its own shirts, made on its MO.
  const dcA = await challan(soA, { sizes: [[S1.id, 10], [S2.id, 10]] }, 'LD')
  check(`${dcA.dcNumber}: ${LD.name}'s order sent from its own 20 shirts`, (await share(fg.id, FG, LD.id, S1.id)).qty === 0 && (await share(fg.id, FG, LD.id, S2.id)).qty === 0)
  const invA = await invoice(dcA, 'LD')
  const invALine = invA.lines?.[0] ?? (await prisma.salesInvoiceLine.findFirstOrThrow({ where: { invoiceId: invA.id }, select: { id: true } }))
  const cn = must(await call('POST', '/sales/credit-notes', { invoiceId: invA.id, type: 'RETURN', warehouseId: FG, reason: `ZZTEST UAT stitching fault ${stamp}`, lines: [{ invoiceLineId: invALine.id, sizes: [{ sizeId: S1.id, qty: 2 }] }] }), 'the credit note')
  check(`${cn.noteNumber}: 2 shirts back from ${invA.invoiceNumber}, on ${LD.name}'s share`, (await share(fg.id, FG, LD.id, S1.id)).qty === 2)

  // ═══ 5. September's shared expenses, split between the brands ═══
  step('5', 'Shared expenses (September 2026)')
  const indirect = await prisma.ledgerGroup.findFirstOrThrow({ where: { systemKey: 'INDIRECT_EXPENSES' }, select: { id: true } })
  const adminDept = (await departmentNamed(prisma as never, 'Administration'))!
  const maintDept = (await departmentNamed(prisma as never, 'Maintenance'))!
  const rent = await prisma.ledger.create({ data: { name: `ZZTEST UAT Rent ${stamp}`, groupId: indirect.id, departmentId: adminDept }, select: { id: true } })
  const power = await prisma.ledger.create({ data: { name: `ZZTEST UAT Power ${stamp}`, groupId: indirect.id, departmentId: maintDept }, select: { id: true } })
  const bank = await prisma.ledger.findFirstOrThrow({ where: { partyType: 'BANK', isActive: true, bankAccountId: { not: null } }, select: { id: true } })
  const pay = async (ledgerId: string, departmentId: string, amount: number, day: string, what: string) =>
    must(
      await call('POST', '/accounts/vouchers', { kind: 'PAYMENT', date: day, mode: 'NEFT', referenceNo: `ZZUAT${stamp}`, narration: `ZZTEST UAT ${what} for September`, requestId: `zzuat-${what}-${stamp}`, lines: [{ ledgerId, side: 'DR', amount, departmentId }, { ledgerId: bank.id, side: 'CR', amount }] }),
      `the ${what} payment`,
    )
  // An earlier walk's September run is reversed and its rules switched off, so this one stands alone.
  for (const r of await prisma.allocationRun.findMany({ where: { period: '2026-09', status: 'POSTED', notes: { startsWith: 'ZZTEST UAT' } }, select: { id: true } })) {
    must(await call('POST', `/accounts/allocation/runs/${r.id}/reverse`, { reason: `ZZTEST UAT walked again ${stamp}` }), "an earlier walk's September run reversed")
  }
  // A rule a run has used stays on record: switched off, saved whole as the rules screen saves it.
  for (const r of await prisma.allocationRule.findMany({ where: { name: { startsWith: 'ZZTEST UAT ' }, isActive: true }, include: { shares: true } })) {
    const whole = { name: r.name, basis: r.basis, ledgerIds: r.ledgerIds, departmentIds: r.departmentIds, costCentreIds: r.costCentreIds, shares: r.shares.map((x) => ({ costCentreId: x.costCentreId, percent: Number(x.percent) })), sortOrder: r.sortOrder, isActive: false, notes: r.notes }
    must(await call('PATCH', `/accounts/allocation/rules/${r.id}`, whole), "an earlier walk's rule switched off")
  }
  const pv1 = await pay(rent.id, adminDept, 30_000, '2026-09-15', 'rent')
  const pv2 = await pay(power.id, maintDept, 12_000, '2026-09-20', 'power')
  const centres = [centre[LD.id], centre[SC.id], centre[C.id]]
  const rule = async (name: string, ledgerId: string, pct: [number, number, number]) =>
    must(await call('POST', '/accounts/allocation/rules', { name: `ZZTEST UAT ${name} ${stamp}`, basis: 'FIXED_PERCENT', ledgerIds: [ledgerId], costCentreIds: centres, shares: centres.map((costCentreId, i) => ({ costCentreId, percent: pct[i] })) }), `the ${name} rule`)
  await rule('rent', rent.id, [50, 30, 20])
  await rule('power', power.id, [40, 40, 20])
  const existing = await prisma.allocationRun.findFirst({ where: { period: '2026-09', status: { in: ['DRAFT', 'APPROVED'] } }, select: { id: true } })
  if (existing) await call('POST', `/accounts/allocation/runs/${existing.id}/rework`, {})
  const run = existing ?? must(await call('POST', '/accounts/allocation/runs', { period: '2026-09', inputs: {}, notes: `ZZTEST UAT ${stamp}` }), 'the September run')
  must(await call('POST', `/accounts/allocation/runs/${run.id}/approve`, {}), 'the run approved')
  must(await call('POST', `/accounts/allocation/runs/${run.id}/post`, {}), 'the run posted')
  const runRow = await prisma.allocationRun.findUniqueOrThrow({ where: { id: run.id }, select: { runNumber: true, status: true } })
  console.log(`${pv1.voucherNo} rent ₹30,000, ${pv2.voucherNo} power ₹12,000; ${runRow.runNumber} ${runRow.status}`)
  const split = await prisma.$queryRaw<Array<{ c: string | null; amt: number }>>`
    SELECT l."costCentreId" c, SUM(l.debit - l.credit)::float8 amt FROM ld_erp.acc_voucher_lines l JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
    WHERE v.status = 'POSTED' AND l."ledgerId" IN (${rent.id}, ${power.id}) GROUP BY 1`
  const at = (c: string | null) => r2(split.find((x) => x.c === c)?.amt ?? 0)
  check(
    `${runRow.runNumber} posted: rent at 50/30/20 and power at 40/40/20 — ${LD.name} ₹19,800, ${SC.name} ₹13,800, ${C.name} ₹8,400, nothing left unsplit`,
    runRow.status === 'POSTED' && at(centre[LD.id]) === 19_800 && at(centre[SC.id]) === 13_800 && at(centre[C.id]) === 8_400 && at(null) === 0,
    split,
  )

  // ═══ 6. Into the books; each month's P&L by brand ═══
  step('6', 'Books and the monthly P&L by brand')
  const posted = await postPending(prisma, admin.id)
  console.log(`documents brought into the books: ${posted.posted} posted, ${posted.unchanged} already there, ${posted.failed.length} could not be`)
  const docs: Array<[string, string, string]> = [
    ['PURCHASE_BILL', shared.bill.id, `the shared bill ${shared.bill.billNumber ?? ''}`],
    ['PURCHASE_BILL', own.bill.id, `${SC.name}'s bill ${own.bill.billNumber ?? ''}`],
    ['SALES_INVOICE', invA.id, invA.invoiceNumber],
    ['SALES_INVOICE', invB.id, invB.invoiceNumber],
    ['SALES_INVOICE', invC.id, invC.invoiceNumber],
    ['CREDIT_NOTE', cn.id, cn.noteNumber],
  ]
  const missing: string[] = []
  for (const [sourceType, sourceId, label] of docs) {
    if (!(await prisma.voucher.findFirst({ where: { sourceType, sourceId, status: 'POSTED' }, select: { id: true } }))) missing.push(label)
  }
  check("every bill, invoice and credit note of the walk has its voucher in the books", missing.length === 0, missing)
  if (posted.failed.length) console.log(`(not the walk's: ${posted.failed.slice(0, 3).map((f) => `${f.number}: ${f.reason.slice(0, 80)}`).join('; ')})`)
  const s = await booksSettings(prisma)
  const sep = await profitAndLoss(prisma, { from: '2026-09-01', to: '2026-09-30' }, s)
  const nov = await profitAndLoss(prisma, { from: `${today.slice(0, 7)}-01`, to: today }, s)
  for (const [label, pl] of [['September', sep], ['November to date', nov]] as const) {
    const sum = r2(pl.brand.reduce((t, b) => t + b.netProfit, 0))
    check(`${label}: the brand columns and Not split add up to the company's net profit (₹${pl.netProfit})`, near(sum, pl.netProfit), { sum, company: pl.netProfit })
    const tin = r2(pl.brand.reduce((t, b) => t + b.transfersIn, 0))
    const tout = r2(pl.brand.reduce((t, b) => t + b.transfersOut, 0))
    check(`${label}: transfers between shares net to nothing (in ₹${tin} = out ₹${tout})`, near(tin, tout))
  }
  const col = (pl: typeof sep, id: string) => pl.brand.find((b) => b.id === id)!
  const cSep = col(sep, centre[C.id])
  check(`September, ${C.name}: its share of the shared expenses, ₹8,400, is its whole result`, near(cSep.netProfit, -8_400), cSep)
  const cNov = col(nov, centre[C.id])
  // What the moved shirts were worth: the receiving share's rows, quantity at the rate they left at.
  const [{ v: movedValue }] = await prisma.$queryRaw<Array<{ v: number | null }>>`
    SELECT SUM("inQty" * "unitRate")::float8 v FROM ld_erp.stock_ledger
    WHERE "itemId" = ${plain.id} AND "brandId" = ${C.id} AND "transactionType" = 'REALLOCATION' AND "inQty" > 0`
  const moveValue = r2(movedValue ?? 0)
  // The brand is the walk's own, kept between walks: its month holds every walk's sales and moves, read from the documents.
  const novFrom = new Date(`${today.slice(0, 7)}-01T00:00:00+05:30`)
  const [{ v: cSales }] = await prisma.$queryRaw<Array<{ v: number }>>`
    SELECT COALESCE(SUM(i."taxableAmount"), 0)::float8 v FROM ld_erp.sales_invoices i JOIN ld_erp.sales_orders o ON o.id = i."soId"
    WHERE o."brandId" = ${C.id} AND i.status <> 'CANCELLED' AND i."invoiceDate" >= ${novFrom}`
  const [{ v: cIn }] = await prisma.$queryRaw<Array<{ v: number }>>`
    SELECT COALESCE(SUM("inQty" * "unitRate"), 0)::float8 v FROM ld_erp.stock_ledger
    WHERE "brandId" = ${C.id} AND "transactionType" = 'REALLOCATION' AND "inQty" > 0 AND "transactionDate" >= ${novFrom}`
  check(
    `November, ${C.name}: this walk sold 5 at ₹400 (₹2,000) of the shirts ${SC.name} handed it at their value (₹${moveValue}): ₹${r2(2000 - moveValue)}; with earlier walks, sales ₹${r2(cSales)} less ₹${r2(cIn)} taken in, nothing left in stock`,
    moveValue === 1250 && near(cNov.transfersIn, r2(cIn)) && near(cNov.closingStock, 0) && near(cNov.netProfit, r2(cSales - cIn)),
    { cNov, moveValue, cSales, cIn },
  )
  const scNov = col(nov, centre[SC.id])
  check(
    `November, ${SC.name}: in, the 8 shirts taken from central on its challan and the 6 earmarked (₹3,500); out, the 5 handed on (₹1,250)`,
    scNov.transfersIn + 0.011 >= 3500 && scNov.transfersOut + 0.011 >= 1250,
    { in: scNov.transfersIn, out: scNov.transfersOut },
  )
  const ldNov = col(nov, centre[LD.id])
  check(`November, ${LD.name}: the 30 m of central fabric issued to its MO shows as its transfer in (₹3,000 at ₹100)`, ldNov.transfersIn + 0.011 >= 3000, { in: ldNov.transfersIn })

  // ═══ 7. Stock agrees with itself ═══
  step('7', 'Stock reconciliation')
  const recon = (await stockReconciliation.run({ tx: prisma, params: {}, rowCap: 5000 } as never)) as { rows: Array<Record<string, unknown>> }
  const names = new Set([`ZZTEST UAT fabric ${stamp}`, `ZZTEST UAT shirt ${stamp}`, `ZZTEST UAT plain shirt ${stamp}`])
  const mine = recon.rows.filter((r) => names.has(String(r.item)))
  check("Stock Reconciliation finds nothing on the walk's items: stickers, holds, cartons, values and every brand share agree", mine.length === 0, mine)
  const leftOf = async (itemId: string) => {
    const rows = await prisma.stockLedger.groupBy({ by: ['brandId'], where: { itemId, warehouseId: FG }, _sum: { inQty: true, outQty: true } })
    return (b: string | null) => r2(rows.filter((x) => x.brandId === b).reduce((t, x) => t + Number(x._sum.inQty ?? 0) - Number(x._sum.outQty ?? 0), 0))
  }
  const ldShirts = await leftOf(fg.id)
  const plainLeft = await leftOf(plain.id)
  check(
    `left in ZZTEST UAT FG: ${LD.name}'s 2 returned shirts; plain shirts central 6, ${SC.name} 1, ${C.name} 0`,
    ldShirts(LD.id) === 2 && ldShirts(null) === 0 && plainLeft(null) === 6 && plainLeft(SC.id) === 1 && plainLeft(C.id) === 0,
    { ld: ldShirts(LD.id), plainCentral: plainLeft(null), sc: plainLeft(SC.id), c: plainLeft(C.id) },
  )

  console.log(
    `\nKept on the demo for you to open: purchases ${shared.po.poNumber}, ${own.po.poNumber} (return ${ret.returnNumber ?? ret.noteNumber ?? ''}); transfer ${tr.transferNumber}; orders ${soA.soNumber}, ${soB.soNumber}, ${soC.soNumber}; ${mo.moNumber}, ${fgr.fgrNumber}; brand transfers ${ear.number}, ${move.number}; challans ${dcA.dcNumber}, ${dcB.dcNumber}, ${dcC.dcNumber}; invoices ${invA.invoiceNumber}, ${invB.invoiceNumber}, ${invC.invoiceNumber}; ${cn.noteNumber}; September ${pv1.voucherNo}, ${pv2.voucherNo}, ${runRow.runNumber}`,
  )
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}

main()
  .catch((e) => {
    console.error(`stopped: ${(e as Error).message}`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
