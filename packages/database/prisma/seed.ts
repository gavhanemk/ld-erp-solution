import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

/**
 * The Indian financial year runs April to March, so anything before April
 * belongs to the year that started the previous calendar year. Hard-coding
 * "2425" left the seeded document numbers two years stale.
 */
function currentFinancialYear(now = new Date()): string {
  const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
  return `${String(startYear).slice(2)}${String(startYear + 1).slice(2)}`
}

const CURRENT_FY = currentFinancialYear()

async function main() {
  console.log('🌱 Seeding LD ERP Solution database...')

  // 1. Company
  // The real registered details, read from the company's live Absolute ERP.
  // These print on every invoice, challan and purchase order, so the earlier
  // placeholder (Surat, Gujarat, GSTIN 24XXXXX0000X1Z5) had to go.
  const company = await prisma.company.upsert({
    where: { id: 'company-1' },
    update: {
      name: 'LD Cotton Mills',
      address: '2nd Floor, AC Building, Rajlaxmi Industrial Complex, Kalher',
      city: 'Bhiwandi, Thane',
      state: 'Maharashtra',
      stateCode: '27',
      pincode: '421302',
      gstin: '27AAFFL6946D1Z7',
      email: 'accounts1@ldcottonmills.com',
      phone: '8169815948',
      currentFY: CURRENT_FY,
      booksStartDate: new Date('2025-04-01'),
    },
    create: {
      id: 'company-1',
      name: 'LD Cotton Mills',
      address: '2nd Floor, AC Building, Rajlaxmi Industrial Complex, Kalher',
      city: 'Bhiwandi, Thane',
      state: 'Maharashtra',
      /// First two digits of the GSTIN. Place of supply is decided from this.
      stateCode: '27',
      pincode: '421302',
      gstin: '27AAFFL6946D1Z7',
      phone: '8169815948',
      email: 'accounts1@ldcottonmills.com',
      currentFY: CURRENT_FY,
      fyStartMonth: 4,
      booksStartDate: new Date('2025-04-01'),
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

  // 5. Departments — the processes LD's floor actually runs, taken from their
  // live Absolute setup. The earlier list folded four separate QC checkpoints
  // into one "Quality Control", which makes it impossible to tell whether
  // pieces are failing at cutting or at final inspection.
  const deptData = [
    { name: 'Cutting', code: 'CUT', sortOrder: 10 },
    { name: 'Cutting QC', code: 'CUTQC', sortOrder: 20 },
    { name: 'Fusing', code: 'FUS', sortOrder: 30 },
    { name: 'Embroidery', code: 'EMB', sortOrder: 40 },
    { name: 'Embroidery QC', code: 'EMBQC', sortOrder: 50 },
    { name: 'Stitching', code: 'STI', sortOrder: 60 },
    { name: 'Line QC', code: 'LINEQC', sortOrder: 70 },
    { name: 'Kaj Button', code: 'KAJ', sortOrder: 80 },
    { name: 'Washing', code: 'WSH', sortOrder: 90 },
    { name: 'Finishing', code: 'FIN', sortOrder: 100 },
    { name: 'Final QC', code: 'FINQC', sortOrder: 110 },
    { name: 'Packing', code: 'PKG', sortOrder: 120 },
    { name: 'Job Work', code: 'JW', sortOrder: 130 },
    { name: 'Store', code: 'STR', sortOrder: 200 },
    { name: 'Accounts', code: 'ACC', sortOrder: 210 },
    { name: 'HR & Admin', code: 'HR', sortOrder: 220 },
  ]

  const departments = new Map<string, string>()
  for (const d of deptData) {
    const dept = await prisma.department.upsert({
      where: { code: d.code },
      update: { name: d.name },
      create: { name: d.name, code: d.code, companyId: company.id },
    })
    departments.set(d.code, dept.id)
  }

  // An earlier seed had a single catch-all "Quality Control" department. It is
  // superseded by the four real checkpoints above, and leaving it active would
  // let entries land in a bucket that hides where pieces are actually failing.
  await prisma.department.updateMany({
    where: { code: 'QC' },
    data: { isActive: false, name: 'Quality Control (superseded)' },
  })

  // 5b. One operation per production process, so a routing has something to
  // point at. SMVs are left blank — they are measured on the floor, not guessed.
  const operationData = deptData
    .filter((d) => !['STR', 'ACC', 'HR'].includes(d.code))
    .map((d) => ({ code: `OP-${d.code}`, name: d.name, deptCode: d.code, sortOrder: d.sortOrder }))

  for (const op of operationData) {
    await prisma.operation.upsert({
      where: { code: op.code },
      update: { name: op.name, sortOrder: op.sortOrder },
      create: {
        code: op.code,
        name: op.name,
        sortOrder: op.sortOrder,
        departmentId: departments.get(op.deptCode)!,
      },
    })
  }

  // 5c. Workstations. At LD most stitching and finishing is done by outside
  // units rather than on their own floor, so the in-house ones are seeded and
  // the job-work units are added against their supplier record as they are set up.
  const workstationData = [
    { code: 'WS-CUT-01', name: 'Cutting Table 1', deptCode: 'CUT' },
    { code: 'WS-CUT-02', name: 'Cutting Table 2', deptCode: 'CUT' },
    { code: 'WS-FUS-01', name: 'Fusing Machine', deptCode: 'FUS' },
    { code: 'WS-KAJ-01', name: 'Kaj Button Unit', deptCode: 'KAJ' },
    { code: 'WS-FIN-01', name: 'Finishing Line 1', deptCode: 'FIN' },
    { code: 'WS-PKG-01', name: 'Packing Bench', deptCode: 'PKG' },
  ]

  for (const w of workstationData) {
    await prisma.workstation.upsert({
      where: { code: w.code },
      update: { name: w.name },
      create: {
        code: w.code,
        name: w.name,
        type: 'IN_HOUSE',
        departmentId: departments.get(w.deptCode)!,
      },
    })
  }

  // 5d. Size runs. A shirt is cut as a size run and that breakup has to survive
  // from the order through cutting to the invoice, so sizes are records rather
  // than typed-in text.
  const sizeGroups = [
    {
      name: "Men's Shirt (Alpha)",
      gender: 'MALE',
      sizes: ['S', 'M', 'L', 'XL', 'XXL', '3XL'],
    },
    {
      name: "Men's Shirt (Collar)",
      gender: 'MALE',
      sizes: ['38', '40', '42', '44', '46', '48'],
    },
    {
      name: "Men's Trouser (Waist)",
      gender: 'MALE',
      sizes: ['28', '30', '32', '34', '36', '38', '40'],
    },
  ]

  for (const g of sizeGroups) {
    const group = await prisma.sizeGroup.upsert({
      where: { name: g.name },
      update: {},
      create: { name: g.name, gender: g.gender },
    })
    for (const [i, code] of g.sizes.entries()) {
      await prisma.size.upsert({
        where: { sizeGroupId_code: { sizeGroupId: group.id, code } },
        update: { sequence: i },
        create: { sizeGroupId: group.id, code, label: code, sequence: i },
      })
    }
  }

  // 5e. The extras LD already bills on top of the goods. Each carries its own
  // GST rate, so none of them can be folded into the garment value.
  const chargeTypes = [
    { name: 'Transport Charges', defaultGstRate: 5, applyOnSale: true, applyOnPurchase: true },
    { name: 'Freight / Courier', defaultGstRate: 18, applyOnSale: true, applyOnPurchase: true },
    { name: 'Dyeing Charges', defaultGstRate: 5, applyOnSale: true, applyOnPurchase: true },
    { name: 'Packing Charges', defaultGstRate: 18, applyOnSale: true, applyOnPurchase: false },
  ]

  for (const c of chargeTypes) {
    await prisma.chargeType.upsert({ where: { name: c.name }, update: {}, create: c })
  }

  // 5f. Direct sales still need a broker record, or every order would have to
  // leave the field blank and the brokerage report would have a hole in it.
  await prisma.broker.upsert({
    where: { code: 'SELF' },
    update: {},
    create: {
      code: 'SELF',
      name: 'Direct (no agent)',
      brokeragePercent: 0,
    },
  })

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

  // 9. Number Series, for the financial year we are actually in.
  const series = [
    { docType: 'SO', prefix: 'SO' },
    { docType: 'PO', prefix: 'PO' },
    { docType: 'MO', prefix: 'MO' },
    { docType: 'GRN', prefix: 'GRN' },
    { docType: 'INV', prefix: 'INV' },
    { docType: 'MR', prefix: 'MR' },
    { docType: 'DC', prefix: 'DC' },
    { docType: 'JW', prefix: 'JW' },
    { docType: 'CN', prefix: 'CN' },
    { docType: 'DN', prefix: 'DN' },
    { docType: 'VCH', prefix: 'VCH' },
  ]

  for (const s of series) {
    await prisma.numberSeries.upsert({
      where: {
        companyId_docType_financialYear: {
          companyId: company.id,
          docType: s.docType,
          financialYear: CURRENT_FY,
        },
      },
      update: {},
      create: {
        ...s,
        financialYear: CURRENT_FY,
        companyId: company.id,
        separator: '-',
        lastNumber: 0,
        padding: 4,
      },
    })
  }

  // 9b. GST rates. 5% is the rate LD confirmed for garments and the only rate
  // configured in their live Absolute account; the others are offered because
  // job work and freight are charged at different rates on the same invoice.
  // Have the rates confirmed by the CA before treating any of them as settled.
  const taxRates = [
    { name: 'GST 0%', rate: 0, isDefault: false },
    { name: 'GST 5%', rate: 5, isDefault: true },
    { name: 'GST 12%', rate: 12, isDefault: false },
    { name: 'GST 18%', rate: 18, isDefault: false },
  ]

  for (const t of taxRates) {
    await prisma.taxRate.upsert({
      where: { companyId_name: { companyId: company.id, name: t.name } },
      // isDefault is corrected on an existing install too — an earlier seed
      // marked 12% as the default, which is not the rate LD charges.
      update: { rate: t.rate, isDefault: t.isDefault },
      create: { ...t, companyId: company.id },
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
