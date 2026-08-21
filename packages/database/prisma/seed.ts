import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding LD ERP Solution database...')

  // 1. Company
  const company = await prisma.company.upsert({
    where: { id: 'company-1' },
    update: {},
    create: {
      id: 'company-1',
      name: 'LD Cotton Mills',
      legalName: 'LD Cotton Mills Pvt Ltd',
      address: 'Industrial Area, Phase 2',
      city: 'Surat',
      state: 'Gujarat',
      pincode: '395010',
      gstin: '24XXXXX0000X1Z5',
      phone: '+91 9999999999',
      email: 'info@ldcottonmills.com',
      currentFY: '2425',
      fyStartMonth: 4,
    },
  })

  // 2. Roles
  const adminRole = await prisma.role.upsert({
    where: { name: 'Admin' },
    update: {},
    create: { name: 'Admin', description: 'Full access to all modules', isSystem: true },
  })

  const mdRole = await prisma.role.upsert({
    where: { name: 'MD' },
    update: {},
    create: { name: 'MD', description: 'Managing Director — read-only + approvals', isSystem: true },
  })

  const accountsRole = await prisma.role.upsert({
    where: { name: 'Accounts Manager' },
    update: {},
    create: { name: 'Accounts Manager', description: 'Accounts & Finance module access' },
  })

  const productionRole = await prisma.role.upsert({
    where: { name: 'Production Manager' },
    update: {},
    create: { name: 'Production Manager', description: 'Production module access' },
  })

  const storeRole = await prisma.role.upsert({
    where: { name: 'Store Manager' },
    update: {},
    create: { name: 'Store Manager', description: 'Inventory & Purchase access' },
  })

  // 3. Admin User
  const hashedPassword = await bcrypt.hash('Admin@123', 12)
  await prisma.user.upsert({
    where: { email: 'admin@ldcottonmills.com' },
    update: {},
    create: {
      name: 'Admin User',
      email: 'admin@ldcottonmills.com',
      passwordHash: hashedPassword,
      roleId: adminRole.id,
      status: 'ACTIVE',
    },
  })

  await prisma.user.upsert({
    where: { email: 'md@ldcottonmills.com' },
    update: {},
    create: {
      name: 'Managing Director',
      email: 'md@ldcottonmills.com',
      phone: '+91 9999999998',
      passwordHash: await bcrypt.hash('MD@12345', 12),
      roleId: mdRole.id,
      status: 'ACTIVE',
    },
  })

  // 4. Brands
  await prisma.brand.upsert({
    where: { id: 'brand-ld' },
    update: {},
    create: {
      id: 'brand-ld',
      companyId: company.id,
      name: 'LD Cotton Mills',
      type: 'LD_COTTON_MILLS',
      description: 'Main B2B and job work brand',
      isActive: true,
    },
  })

  await prisma.brand.upsert({
    where: { id: 'brand-vhagar' },
    update: {},
    create: {
      id: 'brand-vhagar',
      companyId: company.id,
      name: 'VHAGAR',
      type: 'VHAGAR',
      description: 'Premium own fashion brand',
      isActive: true,
    },
  })

  // 5. Departments
  const deptData = [
    { name: 'Cutting', code: 'CUT' },
    { name: 'Stitching', code: 'STI' },
    { name: 'Finishing', code: 'FIN' },
    { name: 'Packing', code: 'PKG' },
    { name: 'Quality Control', code: 'QC' },
    { name: 'Store', code: 'STR' },
    { name: 'Accounts', code: 'ACC' },
    { name: 'HR & Admin', code: 'HR' },
  ]

  for (const d of deptData) {
    await prisma.department.upsert({
      where: { code: d.code },
      update: {},
      create: { ...d, companyId: company.id },
    })
  }

  // 6. Warehouse
  await prisma.warehouse.upsert({
    where: { code: 'WH-MAIN' },
    update: {},
    create: {
      companyId: company.id,
      name: 'Main Warehouse',
      code: 'WH-MAIN',
      address: 'Factory Premises',
    },
  })

  // 7. UOMs
  const uoms = [
    { name: 'Meter', symbol: 'mtr' },
    { name: 'Kilogram', symbol: 'kg' },
    { name: 'Piece', symbol: 'pcs' },
    { name: 'Set', symbol: 'set' },
    { name: 'Roll', symbol: 'roll' },
    { name: 'Dozen', symbol: 'doz' },
    { name: 'Box', symbol: 'box' },
    { name: 'Gram', symbol: 'gm' },
  ]

  for (const uom of uoms) {
    await prisma.uOM.upsert({ where: { symbol: uom.symbol }, update: {}, create: uom })
  }

  // 8. Item Categories
  const cats = ['Fabric', 'Thread', 'Buttons & Fasteners', 'Labels & Tags', 'Packing Material', 'Trims & Accessories', 'Finished Goods']
  for (const cat of cats) {
    await prisma.itemCategory.upsert({ where: { name: cat }, update: {}, create: { name: cat } })
  }

  // 9. Number Series
  const series = [
    { docType: 'SO', prefix: 'SO', financialYear: '2425' },
    { docType: 'PO', prefix: 'PO', financialYear: '2425' },
    { docType: 'MO', prefix: 'MO', financialYear: '2425' },
    { docType: 'GRN', prefix: 'GRN', financialYear: '2425' },
    { docType: 'INV', prefix: 'INV', financialYear: '2425' },
    { docType: 'MR', prefix: 'MR', financialYear: '2425' },
    { docType: 'DC', prefix: 'DC', financialYear: '2425' },
    { docType: 'VCH', prefix: 'VCH', financialYear: '2425' },
  ]

  for (const s of series) {
    await prisma.numberSeries.upsert({
      where: { companyId_docType_financialYear: { companyId: company.id, docType: s.docType, financialYear: s.financialYear } },
      update: {},
      create: { ...s, companyId: company.id, separator: '-', lastNumber: 0, padding: 4 },
    })
  }

  // 10. Permission matrix (module x action), then wire it to the roles.
  // Without these rows every non-Admin user is refused by requirePermission.
  const MODULES = [
    'dashboard', 'masters', 'sales', 'purchase', 'inventory',
    'production', 'accounts', 'hr', 'vhagar', 'maintenance', 'ai', 'settings', 'admin',
  ]
  const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export']

  const permissionIds = new Map<string, string>()
  for (const module of MODULES) {
    for (const action of ACTIONS) {
      const perm = await prisma.permission.upsert({
        where: { module_action: { module, action } },
        update: {},
        create: { module, action },
      })
      permissionIds.set(`${module}:${action}`, perm.id)
    }
  }

  /** Grant every action on the listed modules. */
  const full = (...modules: string[]) =>
    modules.flatMap((m) => ACTIONS.map((a) => `${m}:${a}`))
  /** Grant only the listed actions on the listed modules. */
  const only = (actions: string[], ...modules: string[]) =>
    modules.flatMap((m) => actions.map((a) => `${m}:${a}`))

  const roleGrants: Array<{ roleId: string; grants: string[] }> = [
    // Admin holds the whole matrix. requirePermission also short-circuits on
    // the Admin role, but the rows are seeded so the UI can render them.
    { roleId: adminRole.id, grants: full(...MODULES) },

    // MD/CEO reviews and signs off; they do not key in transactions.
    {
      roleId: mdRole.id,
      grants: only(['view', 'approve', 'export'], ...MODULES),
    },

    {
      roleId: accountsRole.id,
      grants: [
        ...full('accounts'),
        ...only(['view', 'export'], 'dashboard', 'masters', 'sales', 'purchase', 'ai'),
        ...only(['view'], 'inventory', 'production'),
      ],
    },

    {
      roleId: productionRole.id,
      grants: [
        ...full('production', 'maintenance'),
        ...only(['view', 'export'], 'dashboard', 'masters', 'inventory', 'ai'),
        ...only(['view'], 'sales'),
      ],
    },

    {
      roleId: storeRole.id,
      grants: [
        ...full('inventory', 'purchase'),
        ...only(['view', 'export'], 'dashboard', 'masters', 'ai'),
        ...only(['view'], 'production'),
      ],
    },
  ]

  for (const { roleId, grants } of roleGrants) {
    for (const key of grants) {
      const permissionId = permissionIds.get(key)
      if (!permissionId) continue
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId } },
        update: {},
        create: { roleId, permissionId },
      })
    }
  }

  console.log(`   Seeded ${permissionIds.size} permissions across ${roleGrants.length} roles`)

  console.log('✅ Database seeded successfully!')
  console.log('')
  console.log('📋 Default credentials:')
  console.log('   Admin: admin@ldcottonmills.com / Admin@123')
  console.log('   MD:    md@ldcottonmills.com    / MD@12345')
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
