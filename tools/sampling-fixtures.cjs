// Fictional masters only. This never loads .env and refuses every database except the local pilot.
const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')
const url = new URL(process.env.DATABASE_URL || '')
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/lderp_sampling')
  throw Error('Sampling fixtures require local lderp_sampling')
const db = new PrismaClient()
// Grants as module:action, the form requirePermission checks. Kept in step with the
// Merchandiser role in seed-core, which the pilot never runs.
const MERCHANDISER_GRANTS = [
  ...['view', 'create', 'edit', 'approve', 'export'].map((a) => `sampling:${a}`),
  ...['view', 'create', 'edit'].map((a) => `purchase:${a}`),
  'inventory:view',
  'masters:view',
  'dashboard:view',
]
// A store keeper who buys, receives and issues stock but cannot open a sample request.
// Masters view is included because the order and receipt screens list items, suppliers
// and stores from Masters, and would load empty without it.
const STORE_GRANTS = [
  ...['view', 'create', 'edit', 'approve'].map((a) => `inventory:${a}`),
  ...['view', 'create', 'edit'].map((a) => `purchase:${a}`),
  'masters:view',
  'dashboard:view',
]
async function fixtureRole(name, description, grants) {
  const role = await db.role.upsert({ where: { name }, update: {}, create: { name, description } })
  for (const key of grants) {
    const [module, action] = key.split(':')
    // Migrations bring only the sampling rows; the rest are made the way seed-core makes them.
    const permission = await db.permission.upsert({
      where: { module_action: { module, action } },
      update: {},
      create: { module, action },
    })
    await db.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    })
  }
  return role
}
async function seed() {
  await db.$queryRaw`SELECT current_database()`
  const company = await db.company.upsert({
    where: { id: 'sample-company' },
    update: {},
    create: { id: 'sample-company', name: 'Example Garment Workshop', currentFY: '2627' },
  })
  // A purchase order is taxed from our GST state against the supplier's and refuses to save
  // without ours. Only empty fields are filled, so anything typed in Settings is kept.
  const stateCode = company.stateCode || '27'
  const companyGst = {
    ...(company.stateCode ? {} : { stateCode, state: company.state || 'Maharashtra' }),
    ...(company.gstin ? {} : { gstin: `${stateCode}EXMPL0001A1Z1` }),
  }
  if (Object.keys(companyGst).length)
    await db.company.update({ where: { id: company.id }, data: companyGst })
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
  // Non-Admin logins, so the pilot shows what each desk can and cannot do.
  const merchRole = await fixtureRole(
    'Merchandiser',
    'Sampling, and purchase for sample materials',
    MERCHANDISER_GRANTS
  )
  const storeRole = await fixtureRole(
    'Local Store',
    'Purchase and stock, no sampling',
    STORE_GRANTS
  )
  for (const u of [
    {
      id: 'sample-merchandiser',
      name: 'Local Merchandiser',
      email: 'merch@example.com',
      roleId: merchRole.id,
    },
    {
      id: 'sample-storekeeper',
      name: 'Local Store Keeper',
      email: 'store@example.com',
      roleId: storeRole.id,
    },
  ])
    await db.user.upsert({
      where: { email: u.email },
      update: {},
      create: { ...u, passwordHash: await bcrypt.hash('LocalSample@123', 10) },
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

  // Masters the merchandiser workflow builds on: buying sample material, receiving it into its
  // own store, routing the making through in-house and outside processes, and numbering it all.
  // The order form fills a line's GST from the item's rate. 5% for fabric and 12% for trims are
  // the pilot's working figures, not confirmed rates.
  const gst = {}
  for (const [name, rate, isDefault] of [
    ['GST 5%', 5, true],
    ['GST 12%', 12, false],
  ])
    gst[rate] = await db.taxRate.upsert({
      where: { companyId_name: { companyId: company.id, name } },
      update: {},
      create: { companyId: company.id, name, rate, isDefault },
    })
  // Keyed on the symbol, as seed-core does: a unit added in the pilot with the same symbol is
  // reused instead of failing the symbol's uniqueness.
  const pieces = await db.uOM.upsert({
    where: { symbol: 'pcs' },
    update: {},
    create: { id: 'sample-uom-pcs', name: 'Sample pieces', symbol: 'pcs' },
  })
  const cones = await db.uOM.upsert({
    where: { symbol: 'cone' },
    update: {},
    create: { id: 'sample-uom-cone', name: 'Sample cones', symbol: 'cone' },
  })
  const trims = await db.itemCategory.upsert({
    where: { name: 'Sample Trims' },
    update: {},
    create: { id: 'sample-category-trims', name: 'Sample Trims', trackPackages: false },
  })
  const consumables = await db.itemCategory.upsert({
    where: { name: 'Sample Consumables' },
    update: {},
    create: { id: 'sample-category-consumables', name: 'Sample Consumables', trackPackages: false },
  })
  for (const item of [
    ['sample-fabric-2', 'EX-FAB-002', 'Example Cotton Poplin', 'RAW_MATERIAL', cat, uom, 5],
    ['sample-button', 'EX-TRM-001', 'Horn button 18L brown', 'TRIM', trims, pieces, 12],
    ['sample-label', 'EX-TRM-002', 'Main label', 'TRIM', trims, pieces, 12],
    ['sample-thread', 'EX-THR-001', 'Sewing thread 40s', 'CONSUMABLE', consumables, cones, 12],
  ]) {
    const [id, code, name, type, category, unit, rate] = item
    await db.item.upsert({
      where: { code },
      update: {},
      create: {
        id,
        code,
        name,
        type,
        categoryId: category.id,
        uomId: unit.id,
        taxRateId: gst[rate].id,
      },
    })
  }

  // Registered in our own state, so their orders split CGST and SGST. Any active supplier can
  // take job work, so the embroidery unit is a SERVICE supplier rather than a separate register.
  const place = { state: 'Maharashtra', stateCode: '27' }
  for (const s of [
    {
      id: 'sample-trims-supplier',
      code: 'EX-SUP-TRIMS',
      name: 'Example Trims Supplier',
      category: 'TRIM',
      gstin: '27EXTRM0001A1Z2',
      address: 'Unit 4, Example Trade Centre',
      city: 'Mumbai',
      pincode: '400001',
    },
    {
      id: 'sample-fabric-mill',
      code: 'EX-SUP-FABRIC',
      name: 'Example Fabric Mill',
      category: 'FABRIC',
      gstin: '27EXFAB0001A1Z3',
      address: 'Plot 12, Example Textile Park',
      city: 'Thane',
      pincode: '400601',
    },
    {
      id: 'sample-embroidery-unit',
      code: 'EX-SUP-EMB',
      name: 'Example Embroidery Unit',
      category: 'SERVICE',
      gstin: '27EXEMB0001A1Z4',
      address: 'Gala 7, Example Industrial Estate',
      city: 'Pune',
      pincode: '411001',
    },
  ])
    await db.supplier.upsert({
      where: { code: s.code },
      update: {},
      create: { ...s, ...place, pan: s.gstin.slice(2, 12) },
    })

  // Cutting is EX-CUT above. The rest take the Process master's OP- codes, whose tail
  // becomes the department's challan prefix (OP-STI gives STI/...).
  // Embroidery and washing usually go to outside units; a route step can still say otherwise.
  const ops = {}
  for (const [dept, deptName, code, name, kind, defaultExecution] of [
    ['STI', 'Stitching', 'OP-STI', 'Stitching', 'STITCHING', 'IN_HOUSE'],
    ['EMB', 'Embroidery', 'OP-EMB', 'Embroidery', 'OTHER', 'OUTSOURCED'],
    ['WSH', 'Washing', 'OP-WSH', 'Washing', 'FINISHING', 'OUTSOURCED'],
    ['FIN', 'Finishing', 'OP-FIN', 'Finishing / Pressing', 'FINISHING', 'IN_HOUSE'],
    ['QC', 'QC', 'OP-QC', 'QC', 'QC', 'IN_HOUSE'],
  ]) {
    const department = await db.department.upsert({
      where: { code: dept },
      update: {},
      create: { code: dept, name: deptName, companyId: company.id },
    })
    ops[code] = await db.operation.upsert({
      where: { code },
      update: {},
      create: { code, name, kind, defaultExecution, departmentId: department.id },
    })
  }
  await db.contractor.upsert({
    where: { code: 'EX-CON-001' },
    update: {},
    create: {
      id: 'sample-tailor',
      code: 'EX-CON-001',
      name: 'Example Sample Tailor',
      operationIds: [ops['OP-STI'].id],
    },
  })

  // Sample material is received and held here, apart from bulk stock. It is an ordinary
  // store until the sourcing phase marks it as the sample room's.
  await db.warehouse.upsert({
    where: { code: 'EX-SAMPLE-STORE' },
    update: {},
    create: {
      id: 'sample-room-store',
      code: 'EX-SAMPLE-STORE',
      name: 'Example Sample Store',
      companyId: company.id,
    },
  })

  // Orders, receipts, bills, enquiries, job work, requisitions and store transfers. As in
  // seed-core, a type that already has a series of any year keeps it, so no second run starts.
  for (const docType of ['PO', 'GRN', 'PB', 'ENQ', 'JW', 'MR', 'STN']) {
    if (await db.numberSeries.findFirst({ where: { companyId: company.id, docType } })) continue
    await db.numberSeries.create({
      data: { companyId: company.id, docType, prefix: docType, financialYear: '2627' },
    })
  }
  console.log('Local fixtures ready: sampler@, merch@ and store@example.com / LocalSample@123')
}
module.exports = { seed }
if (require.main === module)
  seed()
    .catch((e) => {
      console.error(e)
      process.exitCode = 1
    })
    .finally(() => db.$disconnect())
