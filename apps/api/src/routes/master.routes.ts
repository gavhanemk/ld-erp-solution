import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { crudRouter, type DeleteUse } from '../lib/crud'
import { writeAuditLog } from '../lib/audit'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import {
  copyBomSchema,
  createBomSchema,
  createBrandSchema,
  createBrokerSchema,
  createChargeTypeSchema,
  createCustomerSchema,
  createDepartmentSchema,
  createItemCategorySchema,
  createItemSchema,
  createMachineSchema,
  createOperationSchema,
  createRoutingSchema,
  createSizeGroupSchema,
  createSizeSchema,
  createStyleSchema,
  createSupplierSchema,
  createUomSchema,
  createBankAccountSchema,
  createWarehouseSchema,
  createWorkstationSchema,
  updateBomSchema,
  updateBrandSchema,
  updateBrokerSchema,
  updateChargeTypeSchema,
  updateCompanySchema,
  updateCustomerSchema,
  updateDepartmentSchema,
  updateItemCategorySchema,
  updateItemSchema,
  updateMachineSchema,
  updateOperationSchema,
  updateRoutingSchema,
  updateSizeGroupSchema,
  updateSizeSchema,
  updateStyleSchema,
  updateSupplierSchema,
  updateUomSchema,
  updateBankAccountSchema,
  updateWarehouseSchema,
  updateWorkstationSchema,
} from '../schemas/master.schemas'

const ITEM_TYPES = new Set([
  'RAW_MATERIAL',
  'SEMI_FINISHED',
  'FINISHED_GOOD',
  'CONSUMABLE',
  'PACKING_MATERIAL',
  'TRIM',
])

/** A filter on an optional link, where the choice 'none' means "not set". */
const noneOr = (field: string) => (values: string[]) => {
  const ids = values.filter((v) => v !== 'none')
  const or: Record<string, unknown>[] = []
  if (ids.length) or.push({ [field]: { in: ids } })
  if (values.includes('none')) or.push({ [field]: null })
  return { OR: or }
}

/**
 * Everything that can point at a department, and what deleting the
 * department does to it. An item or a BOM line may have no department, so
 * it is left blank. The rest must have one (a requisition has to say who
 * asked), so they move to the department the person picks.
 */
const DEPARTMENT_USES: Record<string, DeleteUse> = {
  items: { one: 'item', many: 'items', model: 'item', field: 'departmentId', then: 'blank' },
  bomLines: { one: 'BOM line', many: 'BOM lines', model: 'bOMLine', field: 'departmentId', then: 'blank' },
  workstations: { one: 'workstation', many: 'workstations', model: 'workstation', field: 'departmentId', then: 'move' },
  operations: { one: 'operation', many: 'operations', model: 'operation', field: 'departmentId', then: 'move' },
  requisitions: { one: 'requisition', many: 'requisitions', model: 'materialRequisition', field: 'departmentId', then: 'move' },
  employees: { one: 'employee', many: 'employees', model: 'employee', field: 'departmentId', then: 'move' },
  machines: { one: 'machine', many: 'machines', model: 'machine', field: 'departmentId', then: 'move' },
  routingSteps: { one: 'routing step', many: 'routing steps', model: 'routingStep', field: 'departmentId', then: 'move' },
  productionEntries: { one: 'production entry', many: 'production entries', model: 'productionEntry', field: 'departmentId', then: 'move' },
}

const router = Router()
const MODULE = 'masters'

/**
 * Warehouses, departments and brands all hang off the company. There is exactly
 * one company row per install, so the UI should never ask which — the id is
 * filled in here instead.
 */
async function currentCompanyId(): Promise<Record<string, unknown>> {
  const company = await prisma.company.findFirst({ select: { id: true } })
  if (!company) {
    throw new AppError(
      'Company profile is not set up yet. Seed the database first.',
      409,
      'NO_COMPANY',
    )
  }
  return { companyId: company.id }
}

// ─────────────────────────────────────────────────────────────
// Straightforward masters — the factory covers list/get/create/update/delete
// ─────────────────────────────────────────────────────────────

router.use(
  '/customers',
  crudRouter({
    model: 'customer',
    module: MODULE,
    entityType: 'Customer',
    createSchema: createCustomerSchema,
    updateSchema: updateCustomerSchema,
    searchFields: ['name', 'code', 'gstin', 'phone', 'email'],
    sortableFields: ['name', 'code', 'createdAt', 'creditLimit'],
    defaultSort: { field: 'name', order: 'asc' },
  }),
)

// ─────────────────────────────────────────────────────────────
// Supplier addresses — a supplier can bill from more than one place
//
// Declared above the `/suppliers` CRUD mount on purpose. `router.use` matches
// on a prefix, so mounted after it these paths would be handed to the CRUD
// router, which would read "cmxyz/addresses" as an id and answer 404.
// ─────────────────────────────────────────────────────────────

const supplierAddressSchema = z.object({
  label: z.string().max(60).optional().nullable(),
  address: z.string().min(1, 'The address cannot be empty').max(400),
  city: z.string().max(80).optional().nullable(),
  state: z.string().max(80).optional().nullable(),
  stateCode: z.string().max(2).optional().nullable(),
  pincode: z.string().max(10).optional().nullable(),
  country: z.string().max(60).optional().nullable(),
  gstin: z.string().max(15).optional().nullable(),
  /** Makes this the one a new order is offered first, and demotes the others. */
  isDefault: z.boolean().optional(),
})

router.get(
  '/suppliers/:id/addresses',
  requirePermission(MODULE, 'view'),
  async (req: AuthRequest, res) => {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    })
    if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')

    const rows = await prisma.supplierAddress.findMany({
      where: { supplierId: req.params.id, isActive: true },
      // The default first, then oldest first, so the list does not reshuffle
      // itself every time somebody adds one.
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })
    res.json({ success: true, data: rows })
  }
)

/**
 * Adds an address to a supplier.
 *
 * This is what "Add new address" on the purchase order form calls, and the
 * point of it is that the address is kept: it goes on the supplier master, so
 * the next order to that supplier offers it too, rather than living on one
 * order as typed text.
 */
router.post(
  '/suppliers/:id/addresses',
  requirePermission(MODULE, 'create'),
  async (req: AuthRequest, res) => {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, address: true },
    })
    if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')

    const data = supplierAddressSchema.parse(req.body)

    const created = await prisma.$transaction(async (tx) => {
      const existing = await tx.supplierAddress.count({
        where: { supplierId: supplier.id, isActive: true },
      })

      // The first address a supplier gets is its default whether or not
      // anybody said so — otherwise the form has a list with nothing marked.
      const beDefault = data.isDefault === true || existing === 0

      if (beDefault) {
        await tx.supplierAddress.updateMany({
          where: { supplierId: supplier.id, isDefault: true },
          data: { isDefault: false },
        })
      }

      const row = await tx.supplierAddress.create({
        data: {
          supplierId: supplier.id,
          label: data.label?.trim() || null,
          address: data.address.trim(),
          city: data.city?.trim() || null,
          state: data.state?.trim() || null,
          stateCode: data.stateCode?.trim() || null,
          pincode: data.pincode?.trim() || null,
          country: data.country?.trim() || 'India',
          gstin: data.gstin?.trim() || null,
          isDefault: beDefault,
        },
      })

      /*
       * The flat fields on the supplier are kept in step when this becomes the
       * default.
       *
       * Those columns are read all over the ERP — the printed order, the bill,
       * the supplier list — and rewriting every one of those to look up an
       * address row is a much larger change than this. So the default address
       * is mirrored back, and the supplier's own fields go on meaning "the
       * address we use for this supplier".
       */
      if (beDefault) {
        await tx.supplier.update({
          where: { id: supplier.id },
          data: {
            address: row.address,
            city: row.city,
            state: row.state,
            stateCode: row.stateCode,
            pincode: row.pincode,
            ...(row.gstin ? { gstin: row.gstin } : {}),
          },
        })
      }

      return row
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'CREATE',
      entityType: 'SupplierAddress',
      entityId: created.id,
      after: created,
    })

    res.status(201).json({
      success: true,
      data: created,
      message: `Address added to ${supplier.name}.`,
    })
  }
)

/** Edits one. The same mirroring applies when it is the default. */
router.patch(
  '/suppliers/:supplierId/addresses/:id',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const before = await prisma.supplierAddress.findUnique({ where: { id: req.params.id } })
    if (!before || before.supplierId !== req.params.supplierId) {
      throw new AppError('Address not found', 404, 'NOT_FOUND')
    }

    const data = supplierAddressSchema.partial().parse(req.body)

    const after = await prisma.$transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx.supplierAddress.updateMany({
          where: { supplierId: before.supplierId, isDefault: true },
          data: { isDefault: false },
        })
      }

      const row = await tx.supplierAddress.update({
        where: { id: before.id },
        data: {
          ...(data.label !== undefined ? { label: data.label?.trim() || null } : {}),
          ...(data.address !== undefined ? { address: data.address.trim() } : {}),
          ...(data.city !== undefined ? { city: data.city?.trim() || null } : {}),
          ...(data.state !== undefined ? { state: data.state?.trim() || null } : {}),
          ...(data.stateCode !== undefined ? { stateCode: data.stateCode?.trim() || null } : {}),
          ...(data.pincode !== undefined ? { pincode: data.pincode?.trim() || null } : {}),
          ...(data.country !== undefined ? { country: data.country?.trim() || 'India' } : {}),
          ...(data.gstin !== undefined ? { gstin: data.gstin?.trim() || null } : {}),
          ...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
        },
      })

      if (row.isDefault) {
        await tx.supplier.update({
          where: { id: row.supplierId },
          data: {
            address: row.address,
            city: row.city,
            state: row.state,
            stateCode: row.stateCode,
            pincode: row.pincode,
            ...(row.gstin ? { gstin: row.gstin } : {}),
          },
        })
      }

      return row
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'SupplierAddress',
      entityId: after.id,
      before,
      after,
    })

    res.json({ success: true, data: after, message: 'Address saved.' })
  }
)

router.use(
  '/suppliers',
  crudRouter({
    model: 'supplier',
    module: MODULE,
    entityType: 'Supplier',
    createSchema: createSupplierSchema,
    updateSchema: updateSupplierSchema,
    searchFields: ['name', 'code', 'gstin', 'phone', 'email'],
    sortableFields: ['name', 'code', 'createdAt', 'rating', 'leadTimeDays'],
    defaultSort: { field: 'name', order: 'asc' },
  }),
)

router.use(
  '/items',
  crudRouter({
    model: 'item',
    module: MODULE,
    entityType: 'Item',
    createSchema: createItemSchema,
    updateSchema: updateItemSchema,
    // Typing "linen" finds linen items by their category as well as their
    // name; "cutting" finds what the cutting floor uses.
    searchFields: [
      'name',
      'code',
      'description',
      'hsnCode',
      'category.name',
      'category.parent.name',
      'department.name',
      'uom.name',
    ],
    sortableFields: ['name', 'code', 'createdAt', 'standardRate'],
    filters: {
      type: {
        // Only real item types reach Prisma; anything else would be a 500.
        where: (v) => ({ type: { in: v.filter((t) => ITEM_TYPES.has(t)) } }),
        facets: ['type'],
      },
      // A main category takes in everything filed under its sub-categories.
      categoryId: {
        where: (v) => ({ OR: [{ categoryId: { in: v } }, { category: { parentId: { in: v } } }] }),
        facets: ['categoryId'],
      },
      subCategoryId: { where: (v) => ({ categoryId: { in: v } }), facets: ['categoryId'] },
      departmentId: { where: noneOr('departmentId'), facets: ['departmentId'] },
      uomId: { where: (v) => ({ uomId: { in: v } }), facets: ['uomId'] },
    },
    facets: ['type', 'categoryId', 'departmentId', 'uomId'],
    defaultSort: { field: 'name', order: 'asc' },
    // taxRate travels with the item so an order form can fill the GST in from
    // the item itself. Without it the purchase order screen read
    // `item.taxRate.rate`, found nothing, and left the field blank for someone
    // to type from memory — and a rate typed from memory is the one thing the
    // business rules say must never happen. The alternative source, the tax
    // rate list in Settings, needs a permission a purchase clerk does not have.
    // The category's parent too, so the form can show a sub-category under the
    // main one it belongs to.
    include: {
      category: { include: { parent: true } },
      uom: true,
      taxRate: true,
      department: { select: { id: true, name: true, code: true } },
    },
  }),
)

router.use(
  '/styles',
  crudRouter({
    model: 'style',
    module: MODULE,
    entityType: 'Style',
    createSchema: createStyleSchema,
    updateSchema: updateStyleSchema,
    searchFields: ['name', 'code', 'season', 'category', 'fabricType'],
    sortableFields: ['name', 'code', 'createdAt', 'season'],
    defaultSort: { field: 'code', order: 'asc' },
    include: { sizeGroup: { select: { id: true, name: true } } },
  }),
)

// No `injectOnCreate`: a bank account belongs to the business, not to one
// of its stores, and the model carries no companyId to fill in.
router.use(
  '/bank-accounts',
  crudRouter({
    model: 'bankAccount',
    module: MODULE,
    entityType: 'BankAccount',
    createSchema: createBankAccountSchema,
    updateSchema: updateBankAccountSchema,
    searchFields: ['accountName', 'bankName', 'accountNumber'],
    sortableFields: ['accountName', 'bankName'],
    defaultSort: { field: 'accountName', order: 'asc' },
  }),
)

router.use(
  '/warehouses',
  crudRouter({
    model: 'warehouse',
    module: MODULE,
    entityType: 'Warehouse',
    createSchema: createWarehouseSchema,
    updateSchema: updateWarehouseSchema,
    injectOnCreate: currentCompanyId,
    searchFields: ['name', 'code'],
    sortableFields: ['name', 'code'],
    defaultSort: { field: 'name', order: 'asc' },
  }),
)

router.use(
  '/departments',
  crudRouter({
    model: 'department',
    module: MODULE,
    entityType: 'Department',
    createSchema: createDepartmentSchema,
    updateSchema: updateDepartmentSchema,
    uniqueFields: ['name'],
    permanentDelete: DEPARTMENT_USES,
    injectOnCreate: currentCompanyId,
    searchFields: ['name', 'code'],
    sortableFields: ['name', 'code'],
    defaultSort: { field: 'name', order: 'asc' },
    // The counts say what a department is holding up before anyone renames or
    // deactivates it.
    include: {
      operations: true,
      _count: {
        select: Object.fromEntries(Object.keys(DEPARTMENT_USES).map((k) => [k, true])),
      },
    },
  }),
)

router.use(
  '/operations',
  crudRouter({
    model: 'operation',
    module: MODULE,
    entityType: 'Operation',
    createSchema: createOperationSchema,
    updateSchema: updateOperationSchema,
    searchFields: ['name', 'code'],
    sortableFields: ['name', 'code', 'smv'],
    defaultSort: { field: 'name', order: 'asc' },
    include: { department: true },
  }),
)

router.use(
  '/machines',
  crudRouter({
    model: 'machine',
    module: MODULE,
    entityType: 'Machine',
    createSchema: createMachineSchema,
    updateSchema: updateMachineSchema,
    searchFields: ['name', 'machineNo', 'type', 'brand', 'model'],
    sortableFields: ['name', 'machineNo', 'createdAt', 'status'],
    defaultSort: { field: 'machineNo', order: 'asc' },
    include: { department: true },
  }),
)

router.use(
  '/uoms',
  crudRouter({
    model: 'uOM',
    module: MODULE,
    entityType: 'UOM',
    createSchema: createUomSchema,
    updateSchema: updateUomSchema,
    searchFields: ['name', 'symbol'],
    sortableFields: ['name', 'symbol'],
    defaultSort: { field: 'name', order: 'asc' },
  }),
)

router.use(
  '/item-categories',
  crudRouter({
    model: 'itemCategory',
    module: MODULE,
    entityType: 'ItemCategory',
    createSchema: createItemCategorySchema,
    updateSchema: updateItemCategorySchema,
    searchFields: ['name'],
    sortableFields: ['name'],
    defaultSort: { field: 'name', order: 'asc' },
    include: { parent: true, children: true },
  }),
)

router.use(
  '/brands',
  crudRouter({
    model: 'brand',
    module: MODULE,
    entityType: 'Brand',
    createSchema: createBrandSchema,
    updateSchema: updateBrandSchema,
    injectOnCreate: currentCompanyId,
    searchFields: ['name', 'description'],
    sortableFields: ['name', 'createdAt'],
    defaultSort: { field: 'name', order: 'asc' },
  }),
)

// ─────────────────────────────────────────────────────────────
// Shop floor and commercial masters
// ─────────────────────────────────────────────────────────────

router.use(
  '/size-groups',
  crudRouter({
    model: 'sizeGroup',
    module: MODULE,
    entityType: 'SizeGroup',
    createSchema: createSizeGroupSchema,
    updateSchema: updateSizeGroupSchema,
    searchFields: ['name'],
    sortableFields: ['name'],
    defaultSort: { field: 'name', order: 'asc' },
    include: { sizes: { orderBy: { sequence: 'asc' } } },
  }),
)

router.use(
  '/sizes',
  crudRouter({
    model: 'size',
    module: MODULE,
    entityType: 'Size',
    createSchema: createSizeSchema,
    updateSchema: updateSizeSchema,
    searchFields: ['code', 'label'],
    sortableFields: ['sequence', 'code'],
    defaultSort: { field: 'sequence', order: 'asc' },
    // Sizes are never referenced by history in their own right; the order line
    // that used one keeps its own quantity, so a hard delete is safe.
    softDelete: false,
    include: { sizeGroup: { select: { id: true, name: true } } },
  }),
)

router.use(
  '/workstations',
  crudRouter({
    model: 'workstation',
    module: MODULE,
    entityType: 'Workstation',
    createSchema: createWorkstationSchema,
    updateSchema: updateWorkstationSchema,
    searchFields: ['name', 'code', 'contactPerson'],
    sortableFields: ['name', 'code', 'createdAt'],
    defaultSort: { field: 'code', order: 'asc' },
    include: {
      department: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true } },
    },
  }),
)

router.use(
  '/brokers',
  crudRouter({
    model: 'broker',
    module: MODULE,
    entityType: 'Broker',
    createSchema: createBrokerSchema,
    updateSchema: updateBrokerSchema,
    searchFields: ['name', 'code', 'phone', 'email'],
    sortableFields: ['name', 'code', 'brokeragePercent'],
    defaultSort: { field: 'name', order: 'asc' },
  }),
)

router.use(
  '/charge-types',
  crudRouter({
    model: 'chargeType',
    module: MODULE,
    entityType: 'ChargeType',
    createSchema: createChargeTypeSchema,
    updateSchema: updateChargeTypeSchema,
    searchFields: ['name'],
    sortableFields: ['name', 'defaultGstRate', 'percentOfValue'],
    defaultSort: { field: 'name', order: 'asc' },
  }),
)

// ─────────────────────────────────────────────────────────────
// Routings — header plus ordered steps, so they need their own handlers
// ─────────────────────────────────────────────────────────────

const routingInclude = {
  style: { select: { id: true, code: true, name: true } },
  steps: {
    orderBy: { sequence: 'asc' as const },
    include: {
      operation: { select: { id: true, name: true, code: true } },
      department: { select: { id: true, name: true } },
      workstation: { select: { id: true, name: true, type: true } },
    },
  },
}

router.get('/routings', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

  const where: Record<string, unknown> = {}
  if (req.query.active === 'true') where.isActive = true
  else if (req.query.active === 'false') where.isActive = false
  if (typeof req.query.styleId === 'string' && req.query.styleId) where.styleId = req.query.styleId
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { code: { contains: q, mode: 'insensitive' } },
      { style: { name: { contains: q, mode: 'insensitive' } } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.routing.findMany({
      where,
      include: routingInclude,
      orderBy: { code: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.routing.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/routings/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const row = await prisma.routing.findUnique({ where: { id: req.params.id }, include: routingInclude })
  if (!row) throw new AppError('Routing not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: row })
})

router.post('/routings', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createRoutingSchema.parse(req.body)
  await assertRoutingRefsExist(data.steps, data.styleId)

  const created = await prisma.routing.create({
    data: {
      code: data.code,
      name: data.name,
      styleId: data.styleId,
      notes: data.notes ?? null,
      isActive: data.isActive ?? true,
      steps: { create: data.steps.map((s) => ({ ...s, workstationId: s.workstationId ?? null })) },
    },
    include: routingInclude,
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'Routing',
    entityId: created.id,
    after: created,
  })

  res.status(201).json({ success: true, data: created })
})

router.patch('/routings/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = updateRoutingSchema.parse(req.body)

  const before = await prisma.routing.findUnique({ where: { id: req.params.id }, include: routingInclude })
  if (!before) throw new AppError('Routing not found', 404, 'NOT_FOUND')

  // A locked routing has orders running against it; changing the steps midway
  // would silently rewrite how work already in progress is supposed to flow.
  if (before.isLocked && data.steps) {
    throw new AppError(
      'This routing is locked because orders are running against it. Unlock it first.',
      400,
      'ROUTING_LOCKED',
    )
  }

  if (data.steps) await assertRoutingRefsExist(data.steps, data.styleId ?? before.styleId)

  const after = await prisma.$transaction(async (tx) => {
    if (data.steps) {
      await tx.routingStep.deleteMany({ where: { routingId: before.id } })
      await tx.routingStep.createMany({
        data: data.steps.map((s) => ({ ...s, workstationId: s.workstationId ?? null, routingId: before.id })),
      })
    }
    return tx.routing.update({
      where: { id: before.id },
      data: {
        ...(data.code ? { code: data.code } : {}),
        ...(data.name ? { name: data.name } : {}),
        ...(data.styleId ? { styleId: data.styleId } : {}),
        ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.isLocked !== undefined ? { isLocked: data.isLocked } : {}),
      },
      include: routingInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'Routing',
    entityId: after.id,
    before,
    after,
  })

  res.json({ success: true, data: after })
})

router.delete('/routings/:id', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const before = await prisma.routing.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('Routing not found', 404, 'NOT_FOUND')

  const after = await prisma.routing.update({ where: { id: before.id }, data: { isActive: false } })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'DELETE',
    entityType: 'Routing',
    entityId: after.id,
    before,
    after,
  })

  res.json({ success: true, message: `Routing "${before.name}" is no longer offered.` })
})

/**
 * Prisma would reject a bad id with a foreign-key error that means nothing to
 * the person filling in the form, so the references are checked up front.
 */
async function assertRoutingRefsExist(
  steps: Array<{ operationId: string; departmentId: string; workstationId?: string | null }>,
  styleId: string,
): Promise<void> {
  const style = await prisma.style.findUnique({ where: { id: styleId }, select: { id: true } })
  if (!style) throw new AppError('That style no longer exists', 400, 'INVALID_STYLE')

  const operationIds = [...new Set(steps.map((s) => s.operationId))]
  const departmentIds = [...new Set(steps.map((s) => s.departmentId))]
  const workstationIds = [...new Set(steps.map((s) => s.workstationId).filter(Boolean))] as string[]

  const [operations, departments, workstations] = await Promise.all([
    prisma.operation.findMany({ where: { id: { in: operationIds } }, select: { id: true } }),
    prisma.department.findMany({ where: { id: { in: departmentIds } }, select: { id: true } }),
    workstationIds.length
      ? prisma.workstation.findMany({ where: { id: { in: workstationIds } }, select: { id: true } })
      : Promise.resolve([]),
  ])

  if (operations.length !== operationIds.length) {
    throw new AppError('One of the operations no longer exists', 400, 'INVALID_OPERATION')
  }
  if (departments.length !== departmentIds.length) {
    throw new AppError('One of the departments no longer exists', 400, 'INVALID_DEPARTMENT')
  }
  if (workstations.length !== workstationIds.length) {
    throw new AppError('One of the workstations no longer exists', 400, 'INVALID_WORKSTATION')
  }
}

// ─────────────────────────────────────────────────────────────
// Company — single record, so it gets read + update only
// ─────────────────────────────────────────────────────────────

router.get('/company', requirePermission(MODULE, 'view'), async (_req, res) => {
  const company = await prisma.company.findFirst({
    include: { brands: true, warehouses: true, departments: true },
  })
  if (!company) throw new AppError('Company profile not set up yet', 404, 'NOT_FOUND')
  res.json({ success: true, data: company })
})

router.patch('/company/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = updateCompanySchema.parse(req.body)

  const before = await prisma.company.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('Company not found', 404, 'NOT_FOUND')

  const updated = await prisma.company.update({ where: { id: req.params.id }, data })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'Company',
    entityId: updated.id,
    before,
    after: updated,
  })

  res.json({ success: true, data: updated })
})

// ─────────────────────────────────────────────────────────────
// BOM — header, component lines and their per-size overrides are written
// together, and every write recomputes line costs and the header roll-up.
// ─────────────────────────────────────────────────────────────

const bomInclude = {
  style: {
    select: { id: true, code: true, name: true, brandType: true, sizeGroupId: true, colors: true },
  },
  baseSize: { select: { id: true, code: true, label: true } },
  approvedBy: { select: { id: true, name: true } },
  routing: {
    select: {
      id: true,
      code: true,
      name: true,
      steps: {
        orderBy: { sequence: 'asc' as const },
        select: {
          id: true,
          sequence: true,
          smv: true,
          ratePerPiece: true,
          isQcStep: true,
          operation: { select: { id: true, name: true, code: true } },
          department: { select: { id: true, name: true } },
          // Who is paid the step's rate — an in-house line, or a job worker.
          workstation: { select: { id: true, name: true, type: true } },
        },
      },
    },
  },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      componentItem: {
        select: { id: true, code: true, name: true, standardRate: true, uom: true },
      },
      department: { select: { id: true, code: true, name: true } },
      sizes: {
        orderBy: { size: { sequence: 'asc' as const } },
        include: { size: { select: { id: true, code: true, label: true, sequence: true } } },
      },
    },
  },
}

const BOM_SORT_FIELDS = ['createdAt', 'version', 'color', 'totalCost', 'status']
const BOM_STATUSES = ['DRAFT', 'APPROVED', 'OBSOLETE']

/**
 * Money is rounded at every step rather than only at the end, so that a clerk
 * checking the screen against a calculator gets the same answer. Quantities
 * keep four places — cloth per garment is measured that finely.
 */
const round = (value: number, places: number) => Number(value.toFixed(places))

type IncomingBomLineSize = { sizeId: string; qtyPerUnit: number | string }

type IncomingBomLine = {
  componentItemId: string
  component?: string | null
  departmentId?: string | null
  qtyPerUnit: number | string
  wastagePercent?: number
  unitCost?: number | string | null
  notes?: string | null
  sortOrder?: number
  sizes?: IncomingBomLineSize[]
}

/**
 * Wastage inflates the quantity actually consumed: cutting 1.65 m of fabric per
 * shirt at 5% wastage really draws 1.7325 m. Rates fall back to the item's
 * standard rate so a BOM can be costed before anyone types a price.
 *
 * An item with no rate anywhere now raises a warning instead of costing at
 * zero. A total that quietly leaves a component out looks exactly like a total
 * that is right, which is the worse of the two failures.
 *
 * Sizes are a sparse override: a size with no row of its own consumes what the
 * line consumes. That fallback is what keeps a BOM with no size run behaving
 * exactly as it did before sizes existed.
 */
async function priceBomLines(lines: IncomingBomLine[], routingId?: string | null) {
  const itemIds = [...new Set(lines.map((l) => l.componentItemId))]
  const items = await prisma.item.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, code: true, name: true, standardRate: true },
  })

  const missing = itemIds.filter((id) => !items.some((i) => i.id === id))
  if (missing.length > 0) {
    throw new AppError(`Unknown component item(s): ${missing.join(', ')}`, 400, 'INVALID_ITEM')
  }

  const byId = new Map(items.map((i) => [i.id, i]))
  const warnings: Array<{ itemId: string; code: string; name: string }> = []

  const priced = lines.map((line, index) => {
    const item = byId.get(line.componentItemId)!
    const qty = Number(line.qtyPerUnit)
    const wastage = Number(line.wastagePercent ?? 0)
    const factor = 1 + wastage / 100

    const typed =
      line.unitCost !== null && line.unitCost !== undefined && line.unitCost !== ''
        ? Number(line.unitCost)
        : null
    const standard = item.standardRate !== null ? Number(item.standardRate) : null
    const rate = typed ?? standard

    if (rate === null) {
      warnings.push({ itemId: item.id, code: item.code, name: item.name })
    }

    const unitCost = round(rate ?? 0, 4)
    const effectiveQty = round(qty * factor, 4)

    // The line's wastage, not a per-size one: size changes how much cloth a
    // garment takes, it does not change how badly the cutter wastes it.
    const sizes = (line.sizes ?? []).map((s) => {
      const sizeQty = Number(s.qtyPerUnit)
      const sizeEffective = round(sizeQty * factor, 4)
      return {
        sizeId: s.sizeId,
        qtyPerUnit: sizeQty,
        effectiveQty: sizeEffective,
        totalCost: round(sizeEffective * unitCost, 2),
      }
    })

    return {
      componentItemId: line.componentItemId,
      component: line.component ?? null,
      departmentId: line.departmentId || null,
      qtyPerUnit: qty,
      wastagePercent: wastage,
      effectiveQty,
      unitCost,
      // Worked out from the rounded quantity and the rounded rate, so that
      // Effective x Rate really does come to Cost on the screen.
      totalCost: round(effectiveQty * unitCost, 2),
      notes: line.notes ?? null,
      sortOrder: line.sortOrder ?? index,
      sizes,
    }
  })

  const totalCost = round(
    priced.reduce((sum, l) => sum + l.totalCost, 0),
    2,
  )

  // Labour comes from the routing's own rates. SMV is carried as minutes and
  // never turned into money — an hourly rate is a setting nobody has decided.
  let labourCost: number | null = null
  let totalSmv: number | null = null

  if (routingId) {
    const steps = await prisma.routingStep.findMany({
      where: { routingId },
      select: { smv: true, ratePerPiece: true },
    })
    if (steps.length > 0) {
      labourCost = round(
        steps.reduce((sum, s) => sum + Number(s.ratePerPiece ?? 0), 0),
        2,
      )
      totalSmv = round(
        steps.reduce((sum, s) => sum + Number(s.smv ?? 0), 0),
        3,
      )
    }
  }

  return { priced, totalCost, labourCost, totalSmv, warnings }
}

type PricedLine = Awaited<ReturnType<typeof priceBomLines>>['priced'][number]

type RateWarning = { itemId: string; code: string; name: string }

/**
 * Saving with a rate missing is allowed — a BOM is often costed before anyone
 * has quoted a price. Saying so is not optional though, because a total that
 * quietly leaves a component out looks exactly like a total that is right.
 *
 * The components are named rather than counted: "3 have no rate" sends
 * somebody hunting down twelve lines to work out which three.
 */
const rateWarning = (warnings: RateWarning[]): string => {
  const names = warnings.map((w) => w.name).join(', ')
  const subject =
    warnings.length === 1 ? 'One component has' : `${warnings.length} components have`
  const them = warnings.length === 1 ? 'it' : 'them'
  return `Saved. ${subject} no rate yet — ${names}. The total leaves ${them} out until a rate is set.`
}

/** Nests the size rows under their line so both are written in one statement. */
function toLineCreate(line: PricedLine) {
  const { sizes, ...rest } = line
  return { ...rest, ...(sizes.length > 0 ? { sizes: { create: sizes } } : {}) }
}

/**
 * Checks the things a foreign key cannot: that the colour, the routing and the
 * sizes named on the lines all belong to the same style as the BOM. Postgres
 * would accept a trouser routing on a shirt BOM quite happily, and nobody would
 * find out until the floor did.
 *
 * `colour.required` is set when a BOM is being made: every new BOM for a style
 * that has colours must say which one. Edits leave it off, so a BOM made before
 * colour was recorded can still be corrected instead of being locked out.
 */
async function assertBomRefsExist(
  styleId: string,
  routingId: string | null | undefined,
  lines: IncomingBomLine[] | undefined,
  baseSizeId: string | null | undefined,
  colour?: { value: string | null | undefined; required: boolean },
): Promise<{ code: string }> {
  const style = await prisma.style.findUnique({
    where: { id: styleId },
    select: { id: true, code: true, sizeGroupId: true, colors: true },
  })
  if (!style) throw new AppError('That style no longer exists', 400, 'INVALID_STYLE')

  if (colour) {
    const value = colour.value?.trim() || null
    const offered = style.colors.join(', ')
    if (style.colors.length > 0) {
      if (!value && colour.required) {
        throw new AppError(
          `${style.code} comes in ${offered}. Pick the colour this BOM is for — each colour has its own BOM.`,
          400,
          'BOM_COLOUR_REQUIRED',
        )
      }
      if (value && !style.colors.includes(value)) {
        throw new AppError(
          `${style.code} does not come in ${value}. Pick one of ${offered}, or add the colour on the style first.`,
          400,
          'BOM_COLOUR_NOT_ON_STYLE',
        )
      }
    } else if (value) {
      throw new AppError(
        `${style.code} has no colours listed yet, so a BOM cannot be made for ${value}. Add the colour on the style first.`,
        400,
        'BOM_COLOUR_NOT_ON_STYLE',
      )
    }
  }

  const departmentIds = [
    ...new Set((lines ?? []).map((l) => l.departmentId).filter((d): d is string => Boolean(d))),
  ]
  if (departmentIds.length > 0) {
    const found = await prisma.department.findMany({
      where: { id: { in: departmentIds } },
      select: { id: true },
    })
    if (found.length !== departmentIds.length) {
      throw new AppError('One of those departments no longer exists', 400, 'INVALID_DEPARTMENT')
    }
  }

  if (routingId) {
    const routing = await prisma.routing.findUnique({
      where: { id: routingId },
      select: { id: true, styleId: true },
    })
    if (!routing) throw new AppError('That routing no longer exists', 400, 'INVALID_ROUTING')
    if (routing.styleId !== styleId) {
      throw new AppError(
        `That routing is for a different style. Pick one made for ${style.code}, or leave it blank.`,
        400,
        'BOM_ROUTING_STYLE_MISMATCH',
      )
    }
  }

  const sizeIds = [
    ...new Set([
      ...(lines ?? []).flatMap((l) => (l.sizes ?? []).map((s) => s.sizeId)),
      ...(baseSizeId ? [baseSizeId] : []),
    ]),
  ]
  if (sizeIds.length === 0) return { code: style.code }

  if (!style.sizeGroupId) {
    throw new AppError(
      `${style.code} has no size run yet, so quantities cannot be set per size. Add one on the style first.`,
      400,
      'BOM_NO_SIZE_GROUP',
    )
  }

  const sizes = await prisma.size.findMany({
    where: { id: { in: sizeIds } },
    select: { id: true, code: true, sizeGroupId: true },
  })
  if (sizes.length !== sizeIds.length) {
    throw new AppError('One of those sizes no longer exists', 400, 'INVALID_SIZE')
  }

  const stray = sizes.find((s) => s.sizeGroupId !== style.sizeGroupId)
  if (stray) {
    throw new AppError(
      `Size ${stray.code} is not in the size run for ${style.code}. Check the size run on the style.`,
      400,
      'BOM_SIZE_NOT_IN_GROUP',
    )
  }

  return { code: style.code }
}

/** "LD-SH-2601 in Dusty Blue", or just the code for a BOM with no colour. */
const bomName = (styleCode: string, color: string | null | undefined) =>
  color ? `${styleCode} in ${color}` : styleCode

/**
 * `typed` is false when no version was sent and 1.0 was assumed. The BOM form
 * no longer asks for a version, so "give this one a different version" would be
 * advice with nowhere to act on it — and a second BOM for one colour is meant
 * to start as a copy anyway.
 */
const versionClash = (
  styleCode: string,
  color: string | null | undefined,
  version: string,
  typed = true,
) =>
  new AppError(
    typed
      ? `${bomName(styleCode, color)} already has a BOM at version ${version}. Give this one a different version, or copy the existing one.`
      : `${bomName(styleCode, color)} already has a BOM. To start a new version, copy that one from the BOM list.`,
    409,
    'BOM_VERSION_EXISTS',
  )

/**
 * Prisma's own message for a repeated version is "styleId,color,version already
 * exists", which is the database talking to itself. This says what to do.
 */
function rethrowVersionClash(
  err: unknown,
  styleCode: string,
  color: string | null | undefined,
  version: string,
  typed = true,
): never {
  const code = (err as { code?: string }).code
  const target = (err as { meta?: { target?: unknown } }).meta?.target
  const hitVersion = Array.isArray(target)
    ? target.includes('version')
    : String(target ?? '').includes('version')

  if (code === 'P2002' && hitVersion) throw versionClash(styleCode, color, version, typed)
  throw err
}

/**
 * The unique constraint catches a repeated colour and version, but Postgres
 * counts two blank colours as different, so two colourless BOMs at one version
 * would both save. Checking first closes that gap, and gives the plain message
 * every time rather than only when the database happens to be the one to catch it.
 */
async function assertVersionFree(
  styleId: string,
  color: string | null | undefined,
  version: string,
  styleCode: string,
  excludeId?: string,
  typed = true,
): Promise<void> {
  const clash = await prisma.bOM.findFirst({
    where: {
      styleId,
      color: color || null,
      version,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  })
  if (clash) throw versionClash(styleCode, color, version, typed)
}

router.get('/bom', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

  const sortField = typeof req.query.sort === 'string' ? req.query.sort : 'createdAt'
  if (!BOM_SORT_FIELDS.includes(sortField)) {
    throw new AppError(
      `Cannot sort by '${sortField}'. Allowed: ${BOM_SORT_FIELDS.join(', ')}`,
      400,
      'INVALID_SORT',
    )
  }
  const sortOrder = req.query.order === 'asc' ? 'asc' : 'desc'

  const where: Record<string, unknown> = {}
  if (req.query.active === 'true') where.isActive = true
  else if (req.query.active === 'false') where.isActive = false
  if (typeof req.query.styleId === 'string' && req.query.styleId) where.styleId = req.query.styleId
  if (typeof req.query.color === 'string' && req.query.color) where.color = req.query.color

  if (typeof req.query.status === 'string' && req.query.status) {
    const status = req.query.status.toUpperCase()
    if (!BOM_STATUSES.includes(status)) {
      throw new AppError(
        `'${req.query.status}' is not a BOM status. Use one of: ${BOM_STATUSES.join(', ')}.`,
        400,
        'INVALID_STATUS',
      )
    }
    where.status = status
  }

  if (q) {
    where.OR = [
      { version: { contains: q, mode: 'insensitive' } },
      { color: { contains: q, mode: 'insensitive' } },
      { style: { name: { contains: q, mode: 'insensitive' } } },
      { style: { code: { contains: q, mode: 'insensitive' } } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.bOM.findMany({
      where,
      include: bomInclude,
      orderBy: { [sortField]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.bOM.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/bom/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const bom = await prisma.bOM.findUnique({ where: { id: req.params.id }, include: bomInclude })
  if (!bom) throw new AppError('BOM not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: bom })
})

router.post('/bom', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { lines, styleId, color, version, notes, isActive, routingId, baseSizeId } =
    createBomSchema.parse(req.body)

  const colour = color?.trim() || null
  const style = await assertBomRefsExist(styleId, routingId, lines, baseSizeId, {
    value: colour,
    required: true,
  })

  const useVersion = version ?? '1.0'
  const typedVersion = version !== undefined
  await assertVersionFree(styleId, colour, useVersion, style.code, undefined, typedVersion)

  const { priced, totalCost, labourCost, warnings } = await priceBomLines(lines, routingId)

  let created
  try {
    created = await prisma.bOM.create({
      data: {
        styleId,
        color: colour,
        version: useVersion,
        routingId: routingId ?? null,
        baseSizeId: baseSizeId ?? null,
        notes: notes ?? null,
        isActive: isActive ?? true,
        totalCost,
        labourCost,
        lines: { create: priced.map(toLineCreate) },
      },
      include: bomInclude,
    })
  } catch (err) {
    rethrowVersionClash(err, style.code, colour, useVersion, typedVersion)
  }

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'BOM',
    entityId: created!.id,
    after: created,
  })

  res.status(201).json({
    success: true,
    ...(warnings.length > 0 ? { message: rateWarning(warnings) } : {}),
    data: created,
  })
})

router.patch('/bom/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { lines, version, notes, isActive, routingId, baseSizeId } = updateBomSchema.parse(req.body)

  const before = await prisma.bOM.findUnique({ where: { id: req.params.id }, include: bomInclude })
  if (!before) throw new AppError('BOM not found', 404, 'NOT_FOUND')

  // An approved BOM is what running orders are costed against. Changing its
  // components underneath them is the whole thing the approval exists to stop;
  // a new version starts from a copy instead. Deactivating it is still allowed,
  // because that is how a master is retired.
  const changesCosting =
    lines !== undefined ||
    routingId !== undefined ||
    baseSizeId !== undefined ||
    version !== undefined
  if (before.status !== 'DRAFT' && changesCosting) {
    throw new AppError(
      'This BOM is approved and orders may be costed against it. Copy it to a new version to change the components.',
      409,
      'BOM_NOT_DRAFT',
    )
  }

  const nextRoutingId = routingId !== undefined ? routingId : before.routingId
  const nextBaseSizeId = baseSizeId !== undefined ? baseSizeId : before.baseSizeId
  if (changesCosting) {
    await assertBomRefsExist(before.styleId, nextRoutingId, lines, nextBaseSizeId)
  }
  // A draft renamed to a version its colour already has. Colour itself cannot be
  // changed here — that is what copying to another colour is for — so the check
  // is against the colour the BOM was made for.
  if (version !== undefined && version !== before.version) {
    await assertVersionFree(before.styleId, before.color, version, before.style.code, before.id)
  }

  // Lines are replaced wholesale rather than diffed: the header total must stay
  // consistent with its lines, and both must move in one transaction.
  let warnings: RateWarning[] = []

  const updated = await prisma.$transaction(async (tx) => {
    // Collected rather than pre-typed from the existing row, so the costs are
    // only sent when something actually recomputed them.
    const costs: { totalCost?: number; labourCost?: number | null } = {}

    if (lines) {
      const repriced = await priceBomLines(lines, nextRoutingId)
      costs.totalCost = repriced.totalCost
      costs.labourCost = repriced.labourCost
      warnings = repriced.warnings

      await tx.bOMLine.deleteMany({ where: { bomId: before.id } })
      // Written one at a time on purpose: createMany cannot write the nested
      // size rows, and it fails silently rather than loudly — the lines save
      // and every size quietly disappears.
      for (const line of repriced.priced) {
        await tx.bOMLine.create({ data: { ...toLineCreate(line), bomId: before.id } })
      }
    } else if (routingId !== undefined) {
      // The components did not move but the routing did, so labour is restated.
      const steps = nextRoutingId
        ? await tx.routingStep.findMany({
            where: { routingId: nextRoutingId },
            select: { ratePerPiece: true },
          })
        : []
      costs.labourCost =
        steps.length > 0
          ? round(
              steps.reduce((sum, s) => sum + Number(s.ratePerPiece ?? 0), 0),
              2,
            )
          : null
    }

    return tx.bOM.update({
      where: { id: before.id },
      data: {
        ...(version !== undefined ? { version } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
        ...(routingId !== undefined ? { routingId: routingId ?? null } : {}),
        ...(baseSizeId !== undefined ? { baseSizeId: baseSizeId ?? null } : {}),
        ...costs,
      },
      include: bomInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'BOM',
    entityId: updated.id,
    before,
    after: updated,
  })

  res.json({
    success: true,
    ...(warnings.length > 0 ? { message: rateWarning(warnings) } : {}),
    data: updated,
  })
})

/**
 * Approving is what makes a BOM the one an order is costed against. Only one
 * per style and colour holds that place, so approving a new version retires the
 * old one of the same colour in the same transaction — otherwise two approved
 * versions sit side by side with nothing choosing between them.
 *
 * Per colour, not per style: approving the white shirt's BOM must leave the
 * dusty blue one alone. Each colour is its own costing.
 *
 * No self-approval bar here, unlike a requisition. Business rule 7 scopes that
 * to documents that need a second person; a BOM is a master, and in a mill this
 * size the person who typed it is often the only one who can judge it.
 */
router.patch(
  '/bom/:id/approve',
  requirePermission(MODULE, 'approve'),
  async (req: AuthRequest, res) => {
    const before = await prisma.bOM.findUnique({
      where: { id: req.params.id },
      include: bomInclude,
    })
    if (!before) throw new AppError('BOM not found', 404, 'NOT_FOUND')

    if (before.status === 'APPROVED') {
      throw new AppError('This BOM is already approved.', 409, 'BOM_ALREADY_APPROVED')
    }
    if (before.status === 'OBSOLETE') {
      throw new AppError(
        'This BOM has been retired. Copy it to a new version if you want to use it again.',
        409,
        'BOM_OBSOLETE',
      )
    }
    if (before.lines.length === 0) {
      throw new AppError('Add at least one component before approving this BOM.', 409, 'BOM_EMPTY')
    }

    // A rate of zero prints as confidently as a real one, so an approval is
    // refused rather than freezing a total that quietly leaves components out.
    const rateless = before.lines.filter((l) => l.unitCost === null || Number(l.unitCost) === 0)
    if (rateless.length > 0) {
      const names = rateless.map((l) => l.componentItem.name).join(', ')
      throw new AppError(
        `${rateless.length} component${rateless.length === 1 ? ' has' : 's have'} no rate yet — ${names}. Set a rate on the item, or type one on the line, before approving.`,
        409,
        'BOM_NO_RATE',
      )
    }

    const after = await prisma.$transaction(async (tx) => {
      await tx.bOM.updateMany({
        where: {
          styleId: before.styleId,
          // null matches null, so BOMs made before colour was recorded form
          // their own group and are not swept up by approving a coloured one.
          color: before.color,
          status: 'APPROVED',
          id: { not: before.id },
        },
        data: { status: 'OBSOLETE' },
      })
      return tx.bOM.update({
        where: { id: before.id },
        data: { status: 'APPROVED', approvedById: req.user!.id, approvedAt: new Date() },
        include: bomInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'APPROVE',
      entityType: 'BOM',
      entityId: after.id,
      before,
      after,
    })

    res.json({
      success: true,
      message: `${bomName(after.style.code, after.color)} v${after.version} is now the approved BOM.`,
      data: after,
    })
  },
)

/**
 * A new version always starts as a copy of an old one. Without this, changing
 * an approved costing would mean re-typing a dozen component lines, and what
 * would happen instead is that somebody edits the approved one.
 *
 * It is also how a new colour's BOM is made. The buttons, labels, thread and
 * packing carry over from the white shirt to the dusty blue one; only the
 * fabric line needs changing, so nobody types the other eleven again.
 *
 * Rates are copied, not re-read from the item master: a copy is a starting
 * point, not a re-quote.
 */
router.post('/bom/:id/copy', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { version, color } = copyBomSchema.parse(req.body)

  const source = await prisma.bOM.findUnique({ where: { id: req.params.id }, include: bomInclude })
  if (!source) throw new AppError('BOM not found', 404, 'NOT_FOUND')

  // The same colour unless another is given, and the same version when only the
  // colour changes — White v1.0 copied to Dusty Blue is naturally Dusty Blue v1.0.
  const targetColour = color !== undefined ? color?.trim() || null : source.color
  const targetVersion = version ?? source.version

  if (targetColour === source.color && targetVersion === source.version) {
    throw new AppError(
      'A copy needs a new version or a different colour, otherwise it is the same BOM twice.',
      400,
      'BOM_COPY_UNCHANGED',
    )
  }

  // The copy is a new BOM, so a style with colours must have one named. This is
  // also the way a BOM made before colour was recorded gets its colours.
  await assertBomRefsExist(source.styleId, null, undefined, null, {
    value: targetColour,
    required: true,
  })
  await assertVersionFree(source.styleId, targetColour, targetVersion, source.style.code)

  let created
  try {
    created = await prisma.bOM.create({
      data: {
        styleId: source.styleId,
        color: targetColour,
        version: targetVersion,
        routingId: source.routingId,
        baseSizeId: source.baseSizeId,
        notes: source.notes,
        isActive: true,
        status: 'DRAFT',
        copiedFromId: source.id,
        totalCost: source.totalCost,
        labourCost: source.labourCost,
        lines: {
          create: source.lines.map((l) => ({
            componentItemId: l.componentItemId,
            component: l.component,
            departmentId: l.departmentId,
            qtyPerUnit: l.qtyPerUnit,
            wastagePercent: l.wastagePercent,
            effectiveQty: l.effectiveQty,
            unitCost: l.unitCost,
            totalCost: l.totalCost,
            notes: l.notes,
            sortOrder: l.sortOrder,
            ...(l.sizes.length > 0
              ? {
                  sizes: {
                    create: l.sizes.map((s) => ({
                      sizeId: s.sizeId,
                      qtyPerUnit: s.qtyPerUnit,
                      effectiveQty: s.effectiveQty,
                      totalCost: s.totalCost,
                    })),
                  },
                }
              : {}),
          })),
        },
      },
      include: bomInclude,
    })
  } catch (err) {
    rethrowVersionClash(err, source.style.code, targetColour, targetVersion)
  }

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'BOM',
    entityId: created!.id,
    after: created,
  })

  res.status(201).json({
    success: true,
    message: `Copied to ${bomName(created!.style.code, targetColour)} v${targetVersion}. It is a draft until you approve it.`,
    data: created,
  })
})

router.delete('/bom/:id', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const before = await prisma.bOM.findUnique({
    where: { id: req.params.id },
    include: { style: { select: { code: true } } },
  })
  if (!before) throw new AppError('BOM not found', 404, 'NOT_FOUND')

  // Retiring is both halves at once: it stops being offered, and it stops being
  // the version an order is costed against.
  const after = await prisma.bOM.update({
    where: { id: before.id },
    data: { isActive: false, status: 'OBSOLETE' },
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'DELETE',
    entityType: 'BOM',
    entityId: before.id,
    before,
    after,
  })

  res.json({
    success: true,
    message: `${bomName(before.style.code, before.color)} v${before.version} is no longer offered.`,
  })
})

export default router
