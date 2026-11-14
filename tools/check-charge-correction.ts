import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { prisma } from '../packages/database/src/index'
import {
  priceDocument,
  priceSaleCharge,
  shareSaleCharge,
  type ChargeTaxSnapshot,
} from '../packages/shared/src/index'
import { gstr1 } from '../apps/api/src/services/accounts/gst.service'
import { resolveChargeConfigurations } from '../apps/api/src/services/chargeConfiguration'
import { priceSalesCharges, chargeShares } from '../apps/api/src/services/salesCharges'

const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url))
const jwt = requireApi('jsonwebtoken')
let checks = 0
function check(name: string, run: () => void) {
  run()
  checks++
  console.log(`PASS ${name}`)
}
const cents = (n: number) => Math.round(n * 100)
const config = (patch: Partial<ChargeTaxSnapshot> = {}): ChargeTaxSnapshot => ({
  version: 1,
  name: 'Test charge',
  treatment: 'EXCLUSIVE',
  followsGoodsRate: false,
  ownRate: 18,
  hsnCodeId: null,
  hsnCode: null,
  taxCategory: 'TAXABLE',
  amountMode: 'FIXED',
  inputAmount: 100,
  basis: 'GOODS_AFTER_DISCOUNT',
  ...patch,
})
function unitChecks() {
  const lines = [
    { qty: 1, rate: 1000, gstRate: 5 },
    { qty: 1, rate: 1000, gstRate: 18 },
  ]
  for (const split of ['IGST', 'CGST_SGST'] as const)
    for (const inclusive of [false, true]) {
      const c = config({
        followsGoodsRate: true,
        treatment: inclusive ? 'INCLUSIVE' : 'EXCLUSIVE',
        amountMode: 'PERCENT',
      })
      const p = priceDocument({
        lines,
        orderDiscount: 200,
        charges: [{ key: 'c', amount: 10, gstRate: 0, config: c }],
        split,
      })
      check(`mixed goods / percentage after discounts / ${split} / ${c.treatment}`, () => {
        assert.equal(p.goodsTaxable, 1800)
        assert.equal(p.charges[0].enteredAmount, 180)
        assert.deepEqual(
          p.charges[0].parts.map((x) => x.gstRate).sort((a, b) => a - b),
          [5, 18]
        )
        assert.equal(cents(p.beforeRound), cents(p.goodsTaxable + p.chargeTotal + p.tax))
        assert.equal(cents(p.tax), cents(p.cgst + p.sgst + p.igst))
        assert.equal(cents(p.byRate.reduce((n, x) => n + x.tax, 0)), cents(p.tax))
        if (inclusive) assert.equal(p.charges[0].payable, 180)
        else assert.equal(p.charges[0].tax, 20.7)
        const sale = priceSaleCharge(
          {
            key: 'c',
            amount: 10,
            treatment: c.treatment,
            followsGoodsRate: true,
            ownRate: 0,
            amountMode: 'PERCENT',
          },
          [
            { taxable: 900, gstRate: 5 },
            { taxable: 900, gstRate: 18 },
          ],
          split === 'CGST_SGST'
        )
        assert.equal(sale.net, p.charges[0].amount)
        assert.equal(sale.tax, p.charges[0].tax)
      })
    }
  for (const taxCategory of ['EXEMPT', 'NIL_RATED', 'NON_GST'] as const) {
    const p = priceDocument({
      lines,
      charges: [{ key: 'c', amount: 100, gstRate: 18, config: config({ taxCategory }) }],
      split: 'IGST',
    })
    check(`zero GST preserves ${taxCategory}`, () => {
      assert.equal(p.charges[0].tax, 0)
      assert.equal(p.charges[0].taxSnapshot?.taxCategory, taxCategory)
      assert.equal(p.charges[0].payable, 100)
    })
  }
  check('multiple fixed charges / inclusive extraction / reverse charge', () => {
    const p = priceDocument({
      lines: [{ qty: 1, rate: 1000, gstRate: 5 }],
      charges: [
        { key: 'own', amount: 118, gstRate: 18, config: config({ treatment: 'INCLUSIVE' }) },
        { key: 'goods', amount: 100, gstRate: 0, config: config({ followsGoodsRate: true }) },
      ],
      split: 'IGST',
      reverseCharge: true,
    })
    assert.equal(p.charges[0].amount, 100)
    assert.equal(p.charges[0].tax, 18)
    assert.equal(p.chargeTax, 23)
    assert.equal(p.total, 1200)
    assert.equal(p.tax, 73)
  })
  check('own HSN is not reassigned to goods just because their rates match', () => {
    const rows = chargeShares(
      [{ hsnCode: '5208', gstRate: 18, taxable: 100, cgst: 9, sgst: 9, igst: 0 }],
      [
        {
          name: 'Freight',
          gstRate: 18,
          netAmount: 100,
          treatment: 'EXCLUSIVE',
          cgst: 9,
          sgst: 9,
          igst: 0,
          taxSnapshot: config({ hsnCode: '9965' }),
        },
      ]
    )
    assert.equal(rows[0].hsn, '9965')
  })
  for (let i = 1; i <= 120; i++) {
    const p = priceDocument({
      lines: [{ qty: 3, rate: i / 7, gstRate: 12 }],
      charges: [
        { key: 'c', amount: i / 13, gstRate: 18, config: config({ treatment: 'INCLUSIVE' }) },
      ],
      split: i % 2 ? 'IGST' : 'CGST_SGST',
    })
    assert.equal(cents(p.charges[0].amount + p.charges[0].tax), cents(p.charges[0].enteredAmount))
    assert.equal(cents(p.beforeRound + p.roundOff), cents(p.total))
  }
  check('tiny mixed-rate charges never produce a negative allocation', () => {
    const parts = shareSaleCharge(
      0.02,
      [0, 5, 12, 18, 28].map((gstRate) => ({ gstRate, taxable: 100 })),
      0
    )
    assert.ok(parts.every((p) => p.amount >= 0))
    assert.equal(cents(parts.reduce((n, p) => n + p.amount, 0)), 2)
  })
  check('120 rounding cases reconcile before GST, tax, inclusive amount and final total', () => {})
}

async function main() {
  unitChecks()
  if (!process.env.CHARGE_TEST_DB) return
  const url = new URL(process.env.DATABASE_URL!)
  assert.equal(url.hostname, 'localhost')
  assert.equal(url.port, '5433')
  assert.equal(url.pathname, '/lderp_charge_test_20261114')
  const db = await prisma.$queryRaw<Array<{ d: string }>>`select current_database() d`
  assert.equal(db[0].d, 'lderp_charge_test_20261114')
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: { name: 'Admin' } },
    include: { role: true },
  })
  const token = jwt.sign(
    { id: admin.id, email: admin.email, name: admin.name, role: 'Admin', roleId: admin.roleId },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  )
  const clerk = jwt.sign(
    {
      id: admin.id,
      email: admin.email,
      name: 'Test clerk',
      role: 'Clerk',
      roleId: admin.roleId,
      permissions: [
        'purchase:create',
        'purchase:edit',
        'purchase:view',
        'sales:create',
        'sales:view',
      ],
    },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  )
  const api = async (path: string, body?: unknown, method = 'POST', auth = token) => {
    const r = await fetch(`http://localhost:5127/api${path}`, {
      method,
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const j = (await r.json()) as {
      data: {
        id: string
        name: string
        taxTreatment: string
        purchaseTaxTreatment: string
        totalAmount: string
        charges: Array<{
          id: string
          amount: string
          gstRate: string
          cgst: string
          sgst: string
          igst: string
          taxSnapshot: ChargeTaxSnapshot & { parts: unknown[] }
        }>
      }
      message?: string
      code?: string
    }
    if (!r.ok) throw new Error(`${r.status} ${path}: ${j.message ?? JSON.stringify(j)}`)
    return j.data
  }
  const stamp = Date.now()
  const hsn = await prisma.hsnCode.create({
    data: {
      code: `99${stamp}`,
      description: 'Charge test classification',
      kind: 'SERVICES',
      gstRate: 18,
    },
  })
  const own = await api('/masters/charge-types', {
    name: `Charge test own ${stamp}`,
    defaultGstRate: 5,
    applyOnSale: true,
    applyOnPurchase: true,
    followsGoodsRate: false,
    salesHsnCodeId: hsn.id,
    defaultGstMode: 'HSN',
    defaultHsnCodeId: hsn.id,
    purchaseTaxTreatment: 'INCLUSIVE',
  })
  check(
    'new master defaults exclusive on sales and supports independent purchase inclusion',
    () => {
      assert.equal(own.taxTreatment, 'EXCLUSIVE')
      assert.equal(own.purchaseTaxTreatment, 'INCLUSIVE')
    }
  )
  const supplier = await prisma.supplier.findFirstOrThrow({
    where: { isActive: true, gstin: { not: null } },
  })
  const item = await prisma.item.findFirstOrThrow({
    where: { isActive: true, type: 'RAW_MATERIAL' },
  })
  const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { isActive: true } })
  const poPayload = {
    supplierId: supplier.id,
    deliveryWarehouseId: warehouse.id,
    poDate: '2026-11-14',
    poType: 'ORDER_LEVEL',
    discountAmount: 100,
    lines: [{ itemId: item.id, qty: 1, unitRate: 1000, gstRate: 12 }],
    charges: [{ chargeTypeId: own.id, amount: 118 }],
  }
  const po = await api('/purchase/orders', poPayload)
  const poCharge = po.charges[0]
  check('PO amount-only entry resolves HSN rate and extracts inclusive GST once', () => {
    assert.equal(Number(poCharge.amount), 100)
    assert.equal(Number(poCharge.gstRate), 18)
    assert.equal(Number(poCharge.cgst) + Number(poCharge.sgst) + Number(poCharge.igst), 18)
    assert.equal(poCharge.taxSnapshot.hsnCode, hsn.code)
  })
  await prisma.hsnCode.update({ where: { id: hsn.id }, data: { gstRate: 28 } })
  await api(
    `/masters/charge-types/${own.id}`,
    { name: `Renamed charge test ${stamp}`, defaultGstRate: 28 },
    'PATCH'
  )
  const edit = await api(
    `/purchase/orders/${po.id}`,
    { ...poPayload, charges: [{ chargeTypeId: own.id, sourceChargeId: poCharge.id, amount: 118 }] },
    'PATCH'
  )
  check('PO edit freezes original name, HSN and rate after master changes', () => {
    assert.equal(Number(edit.charges[0].gstRate), 18)
    assert.equal(edit.charges[0].taxSnapshot.name, own.name)
    assert.equal(edit.totalAmount, po.totalAmount)
  })
  const prep = (await fetch(`http://localhost:5127/api/purchase/orders/${po.id}/unbilled-charges`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json())) as { data: Array<{ amount: number; amountMode: string }> }
  check('inclusive PO bill preparation carries entered total, not the net value', () => {
    assert.equal(Number(prep.data[0].amount), 118)
    assert.equal(prep.data[0].amountMode, 'FIXED')
  })
  const bill = await api('/purchase/bills', {
    supplierId: supplier.id,
    poId: po.id,
    supplierInvoiceNo: `CHARGE-${stamp}`,
    supplierInvoiceDate: '2026-11-14',
    billDate: '2026-11-14',
    discountAmount: 100,
    lines: [{ itemId: item.id, qty: 1, unitPrice: 1000, gstRate: 12 }],
    charges: [
      {
        chargeTypeId: own.id,
        sourceChargeId: edit.charges[0].id,
        amount: 118,
        amountMode: 'FIXED',
      },
    ],
  })
  check('PO to purchase bill preserves approved tax configuration and total', () => {
    assert.equal(Number(bill.charges[0].gstRate), 18)
    assert.equal(bill.charges[0].taxSnapshot.hsnCode, hsn.code)
    assert.equal(Number(bill.totalAmount), Number(po.totalAmount))
  })
  const inherited = await api('/masters/charge-types', {
    name: `Charge test inherited ${stamp}`,
    defaultGstRate: 0,
    applyOnSale: true,
    applyOnPurchase: true,
    followsGoodsRate: true,
    defaultGstMode: 'INHERIT',
  })
  const mixedPayload = {
    ...poPayload,
    lines: [
      { itemId: item.id, qty: 1, unitRate: 1000, gstRate: 5 },
      { itemId: item.id, qty: 1, unitRate: 1000, gstRate: 18 },
    ],
    charges: [{ chargeTypeId: inherited.id, amount: 10, amountMode: 'PERCENT' }],
  }
  const mixed = await api('/purchase/orders', mixedPayload)
  check('purchase inherited percentage is persisted with both rate allocations', () => {
    assert.equal(Number(mixed.charges[0].amount), 190)
    assert.equal(mixed.charges[0].taxSnapshot.amountMode, 'PERCENT')
    assert.equal(mixed.charges[0].taxSnapshot.parts.length, 2)
  })
  const badOverride = {
    ...poPayload,
    charges: [
      {
        chargeTypeId: own.id,
        amount: 100,
        taxOverride: {
          mode: 'MANUAL',
          treatment: 'EXCLUSIVE',
          gstRate: 0,
          taxCategory: 'NIL_RATED',
          reason: 'Testing access enforcement',
        },
      },
    ],
  }
  await assert.rejects(() => api('/purchase/orders', badOverride, 'POST', clerk), /403/)
  check('server refuses unauthorized manual tax overrides', () => {})
  const overridden = await api('/purchase/orders', badOverride)
  check('authorized override saves its reason and separate zero-tax category', () => {
    assert.equal(overridden.charges[0].taxSnapshot.overrideReason, 'Testing access enforcement')
    assert.equal(overridden.charges[0].taxSnapshot.taxCategory, 'NIL_RATED')
  })
  const customer = await prisma.customer.findFirstOrThrow({
    where: { isActive: true, gstin: { not: null } },
  })
  const garment = await prisma.item.findFirstOrThrow({
    where: { isActive: true, type: 'FINISHED_GOOD', styleId: { not: null } },
    include: { style: true },
  })
  const quote = await api('/sales/quotations', {
    customerId: customer.id,
    quoteDate: '2026-11-14',
    isJobWork: true,
    lines: [{ itemId: garment.id, qty: 1, unitPrice: 1000, jobGstRate: 12 }],
    charges: [{ chargeTypeId: inherited.id, amount: 10, amountMode: 'PERCENT' }],
  })
  await api(
    `/masters/charge-types/${inherited.id}`,
    { followsGoodsRate: false, defaultGstRate: 28 },
    'PATCH'
  )
  const size = garment.style?.sizeGroupId
    ? await prisma.size.findFirstOrThrow({ where: { sizeGroupId: garment.style.sizeGroupId } })
    : null
  const order = await api('/sales/orders', {
    customerId: customer.id,
    quotationId: quote.id,
    orderDate: '2026-11-14',
    isJobWork: true,
    lines: [
      {
        itemId: garment.id,
        totalQty: 1,
        unitPrice: 1000,
        jobGstRate: 12,
        ...(size ? { sizes: [{ sizeId: size.id, qty: 1 }] } : {}),
      },
    ],
    charges: [
      {
        chargeTypeId: inherited.id,
        sourceChargeId: quote.charges[0].id,
        amount: 10,
        amountMode: 'PERCENT',
      },
    ],
  })
  check(
    'job-work quotation to sales order preserves percentage and inheritance after master change',
    () => {
      assert.equal(Number(order.charges[0].amount), 100)
      assert.equal(Number(order.charges[0].gstRate), 12)
      assert.equal(order.charges[0].taxSnapshot.amountMode, 'PERCENT')
      assert.equal(Number(order.totalAmount), Number(quote.totalAmount))
    }
  )
  const saved = await prisma.salesOrderCharge.findMany({ where: { soId: order.id } })
  const invoiceRows = await prisma.$transaction((tx) =>
    priceSalesCharges(
      tx,
      [
        {
          chargeTypeId: inherited.id,
          sourceChargeId: saved[0].id,
          amount: 10,
          amountMode: 'PERCENT',
        },
      ],
      false,
      [{ taxable: 1000, gstRate: 12 }],
      { split: true, saved }
    )
  )
  check('job-work order to invoice pricing retains source configuration', () => {
    assert.equal(invoiceRows[0].gstRate, 12)
    assert.equal(invoiceRows[0].amount, 100)
    assert.equal(invoiceRows[0].igst, 12)
  })
  const soLine = await prisma.salesOrderLine.findFirstOrThrow({ where: { soId: order.id } })
  const dc = await prisma.deliveryChallan.create({
    data: {
      dcNumber: `CHARGE-DC-${stamp}`,
      soId: order.id,
      status: 'DISPATCHED',
      lines: {
        create: [
          {
            description: garment.name,
            qty: 1,
            uomId: garment.uomId,
            soLineId: soLine.id,
            itemId: garment.id,
          },
        ],
      },
    },
  })
  const company = await prisma.company.findFirstOrThrow()
  await prisma.company.update({
    where: { id: company.id },
    data: { booksStartDate: new Date('2026-04-01'), booksLockedUpTo: null },
  })
  const invoice = await api('/sales/invoices', {
    dcId: dc.id,
    invoiceDate: '2026-11-14',
    charges: [
      {
        chargeTypeId: inherited.id,
        sourceChargeId: saved[0].id,
        amount: 10,
        amountMode: 'PERCENT',
      },
    ],
  })
  check(
    'actual job-work sales invoice saves the source percentage and reconciles to its order',
    () => {
      assert.equal(Number(invoice.totalAmount), Number(order.totalAmount))
      assert.equal(Number(invoice.charges[0].gstRate), 12)
      assert.equal(invoice.charges[0].taxSnapshot.amountMode, 'PERCENT')
    }
  )
  const voucher = await prisma.voucher.findUniqueOrThrow({
    where: { sourceType_sourceId: { sourceType: 'SALES_INVOICE', sourceId: invoice.id } },
    include: { lines: true },
  })
  check('invoice accounting debits and credits reconcile to its total', () => {
    assert.equal(
      cents(voucher.lines.reduce((n, l) => n + Number(l.debit), 0)),
      cents(Number(invoice.totalAmount))
    )
    assert.equal(
      cents(voucher.lines.reduce((n, l) => n + Number(l.credit), 0)),
      cents(Number(invoice.totalAmount))
    )
  })
  const report = await prisma.$transaction((tx) => gstr1(tx, '2026-11-14', '2026-11-14'))
  const reported = [...report.b2b, ...report.b2cl].find((d) => d.id === invoice.id)
  check('GSTR-1 includes goods and charge exactly once', () => {
    assert.ok(reported)
    assert.equal(cents(reported.rates.reduce((n, r) => n + r.taxable, 0)), 110000)
    assert.equal(cents(reported.rates.reduce((n, r) => n + r.cgst + r.sgst + r.igst, 0)), 13200)
  })
  const legacy = await prisma.$transaction((tx) =>
    resolveChargeConfigurations(tx, [{ chargeTypeId: own.id, amount: 100 }], 'purchase', {
      saved: [{ chargeTypeId: own.id, amount: 100, gstRate: 5 }],
    })
  )
  check('legacy row retains saved rate rather than current master HSN rate', () =>
    assert.equal(legacy[0].config.ownRate, 5)
  )
  console.log(`\n${checks} checks passed`)
}
main()
  .catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
