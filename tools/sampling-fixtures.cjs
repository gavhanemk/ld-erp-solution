// Fictional masters only. This never loads .env and refuses every database except the local pilot.
const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')
const url = new URL(process.env.DATABASE_URL || '')
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/lderp_sampling')
  throw Error('Sampling fixtures require local lderp_sampling')
const db = new PrismaClient()
async function seed() {
  await db.$queryRaw`SELECT current_database()`
  const company = await db.company.upsert({
    where: { id: 'sample-company' },
    update: {},
    create: { id: 'sample-company', name: 'Example Garment Workshop', currentFY: '2627' },
  })
  const role = await db.role.upsert({
    where: { name: 'Admin' },
    update: {},
    create: { name: 'Admin' },
  })
  await db.user.upsert({
    where: { email: 'sampler@example.com' },
    update: {},
    create: {
      id: 'sample-user',
      name: 'Local Sample Manager',
      email: 'sampler@example.com',
      passwordHash: await bcrypt.hash('LocalSample@123', 10),
      roleId: role.id,
    },
  })
  const brand = await db.brand.upsert({
    where: { id: 'sample-brand' },
    update: {},
    create: { id: 'sample-brand', companyId: company.id, name: 'Example Studio', type: 'CUSTOM' },
  })
  await db.customer.upsert({
    where: { code: 'SAMPLE-BUYER' },
    update: {},
    create: { id: 'sample-buyer', code: 'SAMPLE-BUYER', name: 'Example Buyer', type: 'DOMESTIC' },
  })
  const group = await db.sizeGroup.upsert({
    where: { name: 'Sample sizes' },
    update: {},
    create: { id: 'sample-sizes', name: 'Sample sizes' },
  })
  for (const [i, code] of ['S', 'M', 'L'].entries())
    await db.size.upsert({
      where: { sizeGroupId_code: { sizeGroupId: group.id, code } },
      update: {},
      create: { id: `sample-size-${code}`, sizeGroupId: group.id, code, label: code, sequence: i },
    })
  await db.style.upsert({
    where: { code: 'EX-SH-2601' },
    update: {},
    create: {
      id: 'sample-style',
      code: 'EX-SH-2601',
      name: 'Example Shirt',
      brandId: brand.id,
      brandType: 'CUSTOM',
      category: 'Shirt',
      colors: ['White', 'Blue'],
      sizeGroupId: group.id,
    },
  })
  const uom = await db.uOM.upsert({
    where: { name: 'Sample metres' },
    update: {},
    create: { id: 'sample-uom', name: 'Sample metres', symbol: 'mtr' },
  })
  const cat = await db.itemCategory.upsert({
    where: { name: 'Sample Fabric' },
    update: {},
    create: { id: 'sample-category', name: 'Sample Fabric', trackPackages: false },
  })
  await db.item.upsert({
    where: { code: 'EX-FAB-001' },
    update: {},
    create: {
      id: 'sample-fabric',
      code: 'EX-FAB-001',
      name: 'Example Cotton',
      type: 'RAW_MATERIAL',
      categoryId: cat.id,
      uomId: uom.id,
    },
  })
  await db.warehouse.upsert({
    where: { code: 'EX-STORE' },
    update: {},
    create: { id: 'sample-store', code: 'EX-STORE', name: 'Example Store', companyId: company.id },
  })
  if (!(await db.stockLedger.findFirst({ where: { referenceType: 'SAMPLING_FIXTURE' } })))
    await db.stockLedger.create({
      data: {
        itemId: 'sample-fabric',
        warehouseId: 'sample-store',
        transactionType: 'OPENING',
        referenceType: 'SAMPLING_FIXTURE',
        referenceId: 'opening',
        inQty: 1000,
        outQty: 0,
        closingStock: 1000,
        unitRate: 100,
      },
    })
  for (const docType of ['SAMPLE'])
    await db.numberSeries.upsert({
      where: {
        companyId_docType_financialYear: { companyId: company.id, docType, financialYear: '2627' },
      },
      update: {},
      create: { companyId: company.id, docType, prefix: 'SMP', financialYear: '2627' },
    })
  const dept = await db.department.upsert({
    where: { code: 'EX-CUT' },
    update: {},
    create: { code: 'EX-CUT', name: 'Example Cutting', companyId: company.id },
  })
  const op = await db.operation.upsert({
    where: { code: 'EX-CUT' },
    update: {},
    create: { code: 'EX-CUT', name: 'Example Cutting', kind: 'CUTTING', departmentId: dept.id },
  })
  await db.routing.upsert({
    where: { code: 'EX-ROUTE' },
    update: {},
    create: {
      id: 'sample-route',
      code: 'EX-ROUTE',
      name: 'Example shirt route',
      styleId: 'sample-style',
      steps: {
        create: {
          sequence: 1,
          operationId: op.id,
          departmentId: dept.id,
          execution: 'IN_HOUSE',
          skip: 'NEVER',
        },
      },
    },
  })
  await db.bOM.upsert({
    where: { id: 'sample-bom' },
    update: {},
    create: {
      id: 'sample-bom',
      styleId: 'sample-style',
      color: 'White',
      version: '1.0',
      status: 'APPROVED',
      approvedAt: new Date(),
      lines: { create: { componentItemId: 'sample-fabric', qtyPerUnit: 2, effectiveQty: 2 } },
    },
  })
  console.log('Local fixtures ready: sampler@example.com / LocalSample@123')
}
module.exports = { seed }
if (require.main === module)
  seed()
    .catch((e) => {
      console.error(e)
      process.exitCode = 1
    })
    .finally(() => db.$disconnect())
