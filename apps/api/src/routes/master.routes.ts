import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { crudRouter } from '../lib/crud'
import { writeAuditLog } from '../lib/audit'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import {
  createBomSchema,
  createBrandSchema,
  createCustomerSchema,
  createDepartmentSchema,
  createItemCategorySchema,
  createItemSchema,
  createMachineSchema,
  createOperationSchema,
  createStyleSchema,
  createSupplierSchema,
  createUomSchema,
  createWarehouseSchema,
  updateBomSchema,
  updateBrandSchema,
  updateCompanySchema,
  updateCustomerSchema,
  updateDepartmentSchema,
  updateItemCategorySchema,
  updateItemSchema,
  updateMachineSchema,
  updateOperationSchema,
  updateStyleSchema,
  updateSupplierSchema,
  updateUomSchema,
  updateWarehouseSchema,
} from '../schemas/master.schemas'

const router = Router()
const MODULE = 'masters'

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
    searchFields: ['name', 'code', 'description', 'hsnCode'],
    sortableFields: ['name', 'code', 'createdAt', 'standardRate'],
    defaultSort: { field: 'name', order: 'asc' },
    include: { category: true, uom: true },
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
    searchFields: ['name', 'code'],
    sortableFields: ['name', 'code'],
    defaultSort: { field: 'name', order: 'asc' },
    include: { operations: true },
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
    searchFields: ['name', 'description'],
    sortableFields: ['name', 'createdAt'],
    defaultSort: { field: 'name', order: 'asc' },
  }),
)

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
// BOM — header and component lines are written together, and every write
// recomputes line costs and the header roll-up.
// ─────────────────────────────────────────────────────────────

const bomInclude = {
  style: { select: { id: true, code: true, name: true, brandType: true } },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      componentItem: {
        select: { id: true, code: true, name: true, standardRate: true, uom: true },
      },
    },
  },
}

type IncomingBomLine = {
  componentItemId: string
  qtyPerUnit: number | string
  wastagePercent?: number
  unitCost?: number | string | null
  notes?: string | null
  sortOrder?: number
}

/**
 * Wastage inflates the quantity actually consumed: cutting 1.65 m of fabric per
 * shirt at 5% wastage really draws 1.7325 m. Rates fall back to the item's
 * standard rate so a BOM can be costed before anyone types a price.
 */
async function priceBomLines(lines: IncomingBomLine[]) {
  const itemIds = [...new Set(lines.map((l) => l.componentItemId))]
  const items = await prisma.item.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, standardRate: true },
  })

  const missing = itemIds.filter((id) => !items.some((i) => i.id === id))
  if (missing.length > 0) {
    throw new AppError(`Unknown component item(s): ${missing.join(', ')}`, 400, 'INVALID_ITEM')
  }

  const rateById = new Map(items.map((i) => [i.id, Number(i.standardRate ?? 0)]))

  const priced = lines.map((line, index) => {
    const qty = Number(line.qtyPerUnit)
    const wastage = Number(line.wastagePercent ?? 0)
    const effectiveQty = qty * (1 + wastage / 100)
    const unitCost = line.unitCost != null ? Number(line.unitCost) : rateById.get(line.componentItemId)!

    return {
      componentItemId: line.componentItemId,
      qtyPerUnit: qty,
      wastagePercent: wastage,
      effectiveQty: Number(effectiveQty.toFixed(4)),
      unitCost: Number(unitCost.toFixed(4)),
      totalCost: Number((effectiveQty * unitCost).toFixed(4)),
      notes: line.notes ?? null,
      sortOrder: line.sortOrder ?? index,
    }
  })

  const totalCost = Number(priced.reduce((sum, l) => sum + l.totalCost, 0).toFixed(2))
  return { priced, totalCost }
}

router.get('/bom', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const where = req.query.styleId ? { styleId: String(req.query.styleId) } : {}

  const [rows, total] = await Promise.all([
    prisma.bOM.findMany({
      where,
      include: bomInclude,
      orderBy: { createdAt: 'desc' },
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
  const { lines, styleId, version, notes, isActive } = createBomSchema.parse(req.body)

  const style = await prisma.style.findUnique({ where: { id: styleId } })
  if (!style) throw new AppError('Style not found', 404, 'NOT_FOUND')

  const { priced, totalCost } = await priceBomLines(lines)

  const created = await prisma.bOM.create({
    data: {
      styleId,
      version: version ?? '1.0',
      notes: notes ?? null,
      isActive: isActive ?? true,
      totalCost,
      lines: { create: priced },
    },
    include: bomInclude,
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'BOM',
    entityId: created.id,
    after: created,
  })

  res.status(201).json({ success: true, data: created })
})

router.patch('/bom/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { lines, version, notes, isActive } = updateBomSchema.parse(req.body)

  const before = await prisma.bOM.findUnique({ where: { id: req.params.id }, include: bomInclude })
  if (!before) throw new AppError('BOM not found', 404, 'NOT_FOUND')

  // Lines are replaced wholesale rather than diffed: the header total must stay
  // consistent with its lines, and both must move in one transaction.
  const updated = await prisma.$transaction(async (tx) => {
    let totalCost = before.totalCost

    if (lines) {
      const priced = await priceBomLines(lines)
      totalCost = priced.totalCost as unknown as typeof before.totalCost
      await tx.bOMLine.deleteMany({ where: { bomId: req.params.id } })
      await tx.bOMLine.createMany({
        data: priced.priced.map((l) => ({ ...l, bomId: req.params.id })),
      })
    }

    return tx.bOM.update({
      where: { id: req.params.id },
      data: {
        ...(version !== undefined ? { version } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
        ...(lines ? { totalCost } : {}),
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

  res.json({ success: true, data: updated })
})

router.delete('/bom/:id', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const before = await prisma.bOM.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('BOM not found', 404, 'NOT_FOUND')

  const updated = await prisma.bOM.update({
    where: { id: req.params.id },
    data: { isActive: false },
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'DELETE',
    entityType: 'BOM',
    entityId: req.params.id,
    before,
    after: updated,
  })

  res.json({ success: true, message: 'BOM deactivated' })
})

export default router
