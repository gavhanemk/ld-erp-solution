import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { prisma } from '../packages/database/src/index'

// Explicitly isolated: never repair or backfill historical challans during a read.
async function main() {
  const url = new URL(process.env.DATABASE_URL!)
  assert.equal(url.hostname, 'localhost')
  assert.equal(url.port, '5433')
  assert.equal(url.pathname, '/lderp_charge_test_20261114')
  const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url))
  const jwt = requireApi('jsonwebtoken')
  // Admin became Super Admin in #79; either is the administrator here.
  const admin = await prisma.user.findFirstOrThrow({ where: { role: { name: { in: ['Super Admin', 'Admin'] } } }, include: { role: true } })
  const token = jwt.sign({ id: admin.id, role: admin.role.name }, process.env.JWT_SECRET!, {
    expiresIn: '1h',
  })
  const order = await prisma.salesOrder.findFirstOrThrow({ include: { customer: true } })
  const other = await prisma.customer.findFirstOrThrow({ where: { id: { not: order.customerId } } })
  const created: string[] = []
  let passed = 0
  const check = (name: string, run: () => void) => {
    run()
    passed++
    console.log(`PASS ${name}`)
  }
  const get = async (path: string) => {
    const response = await fetch(`http://localhost:5127/api/sales/challans${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const json = (await response.json()) as any
    assert.equal(response.status, 200, JSON.stringify(json))
    return json.data
  }
  try {
    const legacy = await prisma.deliveryChallan.create({
      data: { dcNumber: `NULL-CUSTOMER-${randomUUID()}`, soId: order.id },
    })
    created.push(legacy.id)
    const explicit = await prisma.deliveryChallan.create({
      data: { dcNumber: `EXPLICIT-CUSTOMER-${randomUUID()}`, soId: order.id, customerId: other.id },
    })
    created.push(explicit.id)
    const list = await get(`?q=${encodeURIComponent(legacy.dcNumber)}`)
    check('legacy list uses the sales order customer', () => {
      assert.equal(list[0].customer.id, order.customerId)
      assert.equal(list[0].customer.name, order.customer.name)
    })
    const detail = await get(`/${legacy.id}`)
    const print = await get(`/${legacy.id}/print`)
    check('detail and print resolve the same customer', () => {
      assert.equal(detail.customer.id, order.customerId)
      assert.equal(print.challan.customer.name, order.customer.name)
      assert.equal(print.challan.customer.billingAddress, order.customer.billingAddress)
    })
    const byName = await get(`?q=${encodeURIComponent(order.customer.name)}&limit=200`)
    const byCustomer = await get(`?customerId=${order.customerId}&limit=200`)
    check('search and customer filtering include legacy challans', () => {
      assert.ok(byName.some((r: any) => r.id === legacy.id))
      assert.ok(byCustomer.some((r: any) => r.id === legacy.id))
      assert.ok(!byCustomer.some((r: any) => r.id === explicit.id))
    })
    const explicitList = await get(`?q=${encodeURIComponent(explicit.dcNumber)}`)
    const explicitPrint = await get(`/${explicit.id}/print`)
    check('an explicitly recorded customer takes precedence', () => {
      assert.equal(explicitList[0].customer.id, other.id)
      assert.equal(explicitPrint.challan.customer.name, other.name)
    })
    const after = await prisma.deliveryChallan.findUniqueOrThrow({ where: { id: legacy.id } })
    check('reading does not rewrite historical customer links or timestamps', () => {
      assert.equal(after.customerId, null)
      assert.equal(after.updatedAt.getTime(), legacy.updatedAt.getTime())
    })
    console.log(`${passed} challan customer checks passed`)
  } finally {
    await prisma.deliveryChallan.deleteMany({ where: { id: { in: created } } })
  }
}
main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
