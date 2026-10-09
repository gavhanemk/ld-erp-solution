import { Router } from 'express'
import { z, ZodError } from 'zod'
import { prisma } from '@ld-erp/database'
import { crudRouter, type DeleteUse } from '../lib/crud'
import { buildTemplate, planImport, readSheet, runImport } from '../services/itemImport.service'
import * as categoryImport from '../services/categoryImport.service'
import * as styleImport from '../services/styleImport.service'
import * as customerImport from '../services/customerImport.service'
import * as supplierImport from '../services/supplierImport.service'
import * as brokerImport from '../services/brokerImport.service'
import * as workstationImport from '../services/workstationImport.service'
import { checkRegistration, fromGstin, stateName } from '../lib/gstStates'
import { writeAuditLog } from '../lib/audit'
import { findHsn, loadHsnIndex, withHsnRates } from '../lib/hsn'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, userCan, type AuthRequest } from '../middleware/auth'
import { assertItemStyleColorValid, rethrowItemStyleColorClash } from '../lib/itemStyleColor'
import {
  bomPriceSchema,
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
  createHsnCodeSchema,
  createDropdownValueSchema,
  updateDropdownValueSchema,
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
  updateHsnCodeSchema,
  updateBankAccountSchema,
  updateWarehouseSchema,
  updateWorkstationSchema,
  gstin,
  stateCode,
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
  itemCategories: { one: 'item category', many: 'item categories', model: 'itemCategory', field: 'departmentId', then: 'blank' },
  bomLines: { one: 'BOM line', many: 'BOM lines', model: 'bOMLine', field: 'departmentId', then: 'blank' },
  workstations: { one: 'workstation', many: 'workstations', model: 'workstation', field: 'departmentId', then: 'move' },
  operations: { one: 'operation', many: 'operations', model: 'operation', field: 'departmentId', then: 'move' },
  requisitions: { one: 'requisition', many: 'requisitions', model: 'materialRequisition', field: 'departmentId', then: 'move' },
  employees: { one: 'employee', many: 'employees', model: 'employee', field: 'departmentId', then: 'move' },
  machines: { one: 'machine', many: 'machines', model: 'machine', field: 'departmentId', then: 'move' },
  routingSteps: { one: 'routing step', many: 'routing steps', model: 'routingStep', field: 'departmentId', then: 'move' },
  productionEntries: { one: 'production entry', many: 'production entries', model: 'productionEntry', field: 'departmentId', then: 'move' },
}

/*
 * What uses a unit. A unit added by mistake ("Mtrs" beside Meter) can be
 * deleted, its items moved to the right one; a challan already printed in it
 * keeps it.
 */
const UOM_USES: Record<string, DeleteUse> = {
  items: { one: 'item', many: 'items', model: 'item', field: 'uomId', then: 'move' },
  challanLines: { one: 'delivery challan line', many: 'delivery challan lines', then: 'refuse' },
}

const router = Router()
const MODULE = 'masters'

/**
 * A filter on a typed-in column (a style's season, a customer's state): the
 * exact values picked, and 'none' for the records with nothing typed.
 */
const textFilter = (field: string) => ({
  where: (v: string[]) => {
    const values = v.filter((x) => x !== 'none')
    const or: Record<string, unknown>[] = []
    if (values.length) or.push({ [field]: { in: values } })
    if (v.includes('none')) or.push({ [field]: null }, { [field]: '' })
    return { OR: or }
  },
  facets: [field],
})

/** A yes/no filter on a boolean column, counted by the same group-by. */
const flagFilter = (field: string) => ({
  where: (v: string[]) =>
    v.includes('true') && v.includes('false') ? {} : { [field]: v.includes('true') },
  facets: [field],
})

/** The body every spreadsheet import posts: the file, and whether to go ahead. */
const importBody = z.object({
  fileName: z.string().min(1).max(200),
  /** The file itself, base64. */
  file: z.string().min(1),
  confirm: z.boolean().optional(),
})

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

/*
 * Customers from a spreadsheet, as items and styles: check first, then all
 * or nothing. New customers only; one already there is skipped. Ahead of the
 * CRUD, whose GET /:id would otherwise take "import-template" for an id.
 */
router.get('/customers/import-template', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const withCurrent = req.query.withCurrent === 'true'
  const buffer = await customerImport.buildTemplate(withCurrent)
  const name = withCurrent ? 'customers-with-current-list.xlsx' : 'customers-import-template.xlsx'
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.send(buffer)
})

router.post('/customers/import', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { fileName, file, confirm } = importBody.parse(req.body)
  const rows = await customerImport.readSheet(Buffer.from(file, 'base64'), fileName)
  const plans = await customerImport.planImport(rows)
  const summary = {
    rows: plans.length,
    newCustomers: plans.filter((p) => p.create).length,
    existing: plans.filter((p) => p.plan.customer === 'existing').length,
    skipped: plans.filter((p) => p.plan.skipped).length,
    problems: plans.filter((p) => p.plan.problems.length > 0).length,
  }
  if (!confirm) {
    return res.json({ success: true, data: { summary, rows: plans.map((p) => p.plan) } })
  }

  const created = await customerImport.runImport(plans)
  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'CustomerImport',
    entityId: `IMPORT-${Date.now()}`,
    after: { fileName, created },
  })
  res.status(201).json({
    success: true,
    message: created.length
      ? `Imported ${created.length} new ${created.length === 1 ? 'customer' : 'customers'}.`
      : 'Nothing to import: every customer is already in the system.',
    data: { summary, created },
  })
})

router.use(
  '/customers',
  crudRouter({
    model: 'customer',
    module: MODULE,
    entityType: 'Customer',
    createSchema: createCustomerSchema,
    updateSchema: updateCustomerSchema,
    // No two with the same name (ignoring capitals and spaces), nor the same GSTIN.
    uniqueFields: ['name', 'gstin'],
    searchFields: ['name', 'code', 'gstin', 'phone', 'email', 'billingCity'],
    sortableFields: ['name', 'code', 'createdAt', 'creditLimit'],
    defaultSort: { field: 'name', order: 'asc' },
    include: { broker: { select: { id: true, name: true } } },
    filters: {
      type: { where: (v) => ({ type: { in: v } }), facets: ['type'] },
      billingState: textFilter('billingState'),
      billingCity: textFilter('billingCity'),
      creditDays: {
        where: (v) => ({ creditDays: { in: v.map(Number).filter(Number.isFinite) } }),
        facets: ['creditDays'],
      },
      // Registered for GST or not: decides whether an invoice carries a GSTIN.
      gst: {
        where: (v) =>
          v.includes('registered') && v.includes('unregistered')
            ? {}
            : v.includes('registered')
              ? { AND: [{ gstin: { not: null } }, { gstin: { not: '' } }] }
              : { OR: [{ gstin: null }, { gstin: '' }] },
        facets: ['gst'],
      },
      brokerId: {
        where: (v) => {
          const ids = v.filter((x) => x !== 'none')
          const or: Record<string, unknown>[] = []
          if (ids.length) or.push({ brokerId: { in: ids } })
          if (v.includes('none')) or.push({ brokerId: null })
          return { OR: or }
        },
        facets: ['brokerId'],
      },
      isBlacklisted: flagFilter('isBlacklisted'),
    },
    facets: ['type', 'billingState', 'billingCity', 'creditDays', 'gst', 'brokerId', 'isBlacklisted'],
    customFacets: {
      gst: async (where) => {
        const [registered, unregistered] = await Promise.all([
          prisma.customer.count({ where: { AND: [where, { gstin: { not: null } }, { gstin: { not: '' } }] } }),
          prisma.customer.count({ where: { AND: [where, { OR: [{ gstin: null }, { gstin: '' }] }] } }),
        ])
        return { registered, unregistered }
      },
    },
    exportSheet: {
      fileName: 'customers',
      build: (rows) => customerImport.customerWorkbook(rows, false),
    },
  }),
)

// ─────────────────────────────────────────────────────────────
// Supplier addresses — a supplier can bill from more than one place
//
// Declared above the `/suppliers` CRUD mount on purpose. `router.use` matches
// on a prefix, so mounted after it these paths would be handed to the CRUD
// router, which would read "cmxyz/addresses" as an id and answer 404.
// ─────────────────────────────────────────────────────────────

const supplierAddressFields = z.object({
  label: z.string().max(60).optional().nullable(),
  address: z.string().min(1, 'The address cannot be empty').max(400),
  city: z.string().max(80).optional().nullable(),
  state: z.string().max(80).optional().nullable(),
  stateCode,
  pincode: z.string().max(10).optional().nullable(),
  country: z.string().max(60).optional().nullable(),
  // Validated like the supplier's own, because the default address's GSTIN
  // is copied onto the supplier: "JUNK" used to get there this way.
  gstin: gstin.optional().nullable(),
  /** Makes this the one a new order is offered first, and demotes the others. */
  isDefault: z.boolean().optional(),
})

type AddressIn = Partial<z.infer<typeof supplierAddressFields>>
const checkAddress = (v: AddressIn, ctx: z.RefinementCtx) =>
  checkRegistration({ gstin: v.gstin, stateCode: v.stateCode }, { stateCode: 'stateCode' }, ctx)
const fillAddress = <T extends AddressIn>(v: T): T => {
  const stateCode = v.stateCode || fromGstin(v.gstin)?.stateCode || v.stateCode
  return stateCode ? { ...v, stateCode, state: stateName(stateCode) ?? v.state } : v
}
const supplierAddressSchema = supplierAddressFields.superRefine(checkAddress).transform(fillAddress)
const supplierAddressUpdateSchema = supplierAddressFields
  .partial()
  .superRefine(checkAddress)
  .transform(fillAddress)

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

    const data = supplierAddressUpdateSchema.parse(req.body)

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

/*
 * Suppliers from a spreadsheet, as customers: check first, then all or
 * nothing. New suppliers only; one already there is skipped. Ahead of the
 * CRUD, whose GET /:id would otherwise take "import-template" for an id.
 */
router.get('/suppliers/import-template', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const withCurrent = req.query.withCurrent === 'true'
  const buffer = await supplierImport.buildTemplate(withCurrent)
  const name = withCurrent ? 'suppliers-with-current-list.xlsx' : 'suppliers-import-template.xlsx'
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.send(buffer)
})

router.post('/suppliers/import', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { fileName, file, confirm } = importBody.parse(req.body)
  const rows = await supplierImport.readSheet(Buffer.from(file, 'base64'), fileName)
  const plans = await supplierImport.planImport(rows)
  const summary = {
    rows: plans.length,
    newSuppliers: plans.filter((p) => p.create).length,
    existing: plans.filter((p) => p.plan.supplier === 'existing').length,
    skipped: plans.filter((p) => p.plan.skipped).length,
    problems: plans.filter((p) => p.plan.problems.length > 0).length,
  }
  if (!confirm) {
    return res.json({ success: true, data: { summary, rows: plans.map((p) => p.plan) } })
  }

  const created = await supplierImport.runImport(plans)
  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'SupplierImport',
    entityId: `IMPORT-${Date.now()}`,
    after: { fileName, created },
  })
  res.status(201).json({
    success: true,
    message: created.length
      ? `Imported ${created.length} new ${created.length === 1 ? 'supplier' : 'suppliers'}.`
      : 'Nothing to import: every supplier is already in the system.',
    data: { summary, created },
  })
})

router.use(
  '/suppliers',
  crudRouter({
    model: 'supplier',
    module: MODULE,
    entityType: 'Supplier',
    createSchema: createSupplierSchema,
    updateSchema: updateSupplierSchema,
    // No two with the same name (ignoring capitals and spaces), nor the same GSTIN.
    uniqueFields: ['name', 'gstin'],
    searchFields: ['name', 'code', 'gstin', 'phone', 'email', 'city'],
    sortableFields: ['name', 'code', 'createdAt', 'rating', 'leadTimeDays'],
    defaultSort: { field: 'name', order: 'asc' },
    filters: {
      category: { where: (v) => ({ category: { in: v } }), facets: ['category'] },
      state: textFilter('state'),
      city: textFilter('city'),
      creditDays: {
        where: (v) => ({ creditDays: { in: v.map(Number).filter(Number.isFinite) } }),
        facets: ['creditDays'],
      },
      rating: {
        where: (v) => {
          const stars = v.filter((x) => x !== 'none').map(Number).filter(Number.isFinite)
          const or: Record<string, unknown>[] = []
          if (stars.length) or.push({ rating: { in: stars } })
          if (v.includes('none')) or.push({ rating: null })
          return { OR: or }
        },
        facets: ['rating'],
      },
      // Registered for GST or not: an unregistered supplier's order carries no GST.
      gst: {
        where: (v) =>
          v.includes('registered') && v.includes('unregistered')
            ? {}
            : v.includes('registered')
              ? { AND: [{ gstin: { not: null } }, { gstin: { not: '' } }] }
              : { OR: [{ gstin: null }, { gstin: '' }] },
        facets: ['gst'],
      },
      isPreferred: flagFilter('isPreferred'),
      isMsme: flagFilter('isMsme'),
    },
    facets: ['category', 'state', 'city', 'creditDays', 'rating', 'gst', 'isPreferred', 'isMsme'],
    customFacets: {
      gst: async (where) => {
        const [registered, unregistered] = await Promise.all([
          prisma.supplier.count({ where: { AND: [where, { gstin: { not: null } }, { gstin: { not: '' } }] } }),
          prisma.supplier.count({ where: { AND: [where, { OR: [{ gstin: null }, { gstin: '' }] }] } }),
        ])
        return { registered, unregistered }
      },
    },
    exportSheet: {
      fileName: 'suppliers',
      build: (rows) => supplierImport.supplierWorkbook(rows, false),
    },
  }),
)

/**
 * What an item is sent back with.
 *
 * - taxRate travels with the item so an order form can fill the GST in from
 *   the item itself. Without it the purchase order screen read
 *   `item.taxRate.rate`, found nothing, and left the field blank for someone
 *   to type from memory — and a rate typed from memory is the one thing the
 *   business rules say must never happen. The alternative source, the tax
 *   rate list in Settings, needs a permission a purchase clerk does not have.
 * - The category's parent too, so the form can show a sub-category under the
 *   main one it belongs to.
 * - The style, for a finished good: which garment it is, with the colours it
 *   comes in.
 */
const itemInclude = {
  category: { include: { parent: true } },
  uom: true,
  taxRate: true,
  department: { select: { id: true, name: true, code: true } },
  style: { select: { id: true, code: true, name: true, colors: true } },
}

/*
 * Items from a spreadsheet: the template to fill, and the filled sheet read
 * back. Posting without `confirm` only checks the sheet and says what each row
 * would do; with it, the whole sheet is written in one go. Ahead of the items
 * CRUD, whose GET /:id would otherwise take "import-template" for an id.
 */
router.get('/items/import-template', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const withItems = req.query.withItems === 'true'
  const buffer = await buildTemplate(withItems)
  const name = withItems ? 'items-with-current-list.xlsx' : 'items-import-template.xlsx'
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.send(buffer)
})

router.post('/items/import', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { fileName, file, confirm } = importBody.parse(req.body)
  const rows = await readSheet(Buffer.from(file, 'base64'), fileName)
  const plans = await planImport(rows)

  // Stock is the inventory's, so bringing it in needs the inventory's right too.
  const withStock = plans.some((p) => p.stock)
  if (withStock && !userCan(req.user, 'inventory', 'create')) {
    throw new AppError(
      'This sheet brings in stock, and your role cannot enter stock. Remove the stock columns, or ask someone from the store.',
      403,
      'NO_STOCK_RIGHT',
    )
  }

  const summary = {
    rows: plans.length,
    newItems: new Set(plans.filter((p) => p.plan.item === 'new').map((p) => p.itemKey)).size,
    existingItems: new Set(plans.filter((p) => p.plan.item === 'existing' && !p.plan.skipped).map((p) => p.itemKey)).size,
    skipped: plans.filter((p) => p.plan.skipped).length,
    stockLines: plans.filter((p) => p.stock).length,
    problems: plans.filter((p) => p.plan.problems.length > 0).length,
  }

  if (!confirm) {
    return res.json({ success: true, data: { summary, rows: plans.map((p) => p.plan) } })
  }

  const done = await runImport(plans)
  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'ItemImport',
    entityId: done.reference,
    after: { fileName, created: done.created, stockLines: done.stockLines },
  })
  res.status(201).json({
    success: true,
    message: `Imported ${done.created.length} new ${done.created.length === 1 ? 'item' : 'items'}${
      done.stockLines ? ` and ${done.stockLines} ${done.stockLines === 1 ? 'line' : 'lines'} of opening stock` : ''
    }.`,
    data: { summary, created: done.created, stockLines: done.stockLines },
  })
})

router.use(
  '/items',
  crudRouter({
    model: 'item',
    module: MODULE,
    entityType: 'Item',
    createSchema: createItemSchema,
    updateSchema: updateItemSchema,
    // No two with the same name (ignoring capitals and spaces).
    uniqueFields: ['name'],
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
    include: itemInclude,
    // Each item goes out with the GST rate its HSN code carries in the HSN
    // master, in `taxRate` where every order and bill form already looks.
    afterRead: (rows) => withHsnRates(prisma, rows),
    // A finished good is one style in one colour, and the colour must be one
    // of that style's own. Checked here because it needs the style looked up,
    // which a schema cannot do. On an edit the saved type, style and colour
    // stand in for whatever the edit leaves out.
    beforeSave: async (data, before) => {
      const checked = await assertItemStyleColorValid(
        String(data.type ?? before?.type ?? ''),
        (data.styleId !== undefined ? data.styleId : before?.styleId) as string | null | undefined,
        (data.color !== undefined ? data.color : before?.color) as string | null | undefined,
        before?.id as string | undefined,
      )
      return {
        data: { ...data, styleId: checked.styleId, color: checked.color },
        // Two people saving the same style and colour at once: the database
        // catches the second, and this says so in words.
        onSaveError: (err) => {
          if (checked.styleName && checked.color) {
            rethrowItemStyleColorClash(err, checked.styleName, checked.color)
          }
        },
      }
    },
  }),
)

/*
 * Styles from a spreadsheet, as items and categories: check first, then all
 * or nothing. New styles only; one already there is skipped. Ahead of the
 * CRUD, whose GET /:id would otherwise take "import-template" for an id.
 */
router.get('/styles/import-template', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const withCurrent = req.query.withCurrent === 'true'
  const buffer = await styleImport.buildTemplate(withCurrent)
  const name = withCurrent ? 'styles-with-current-list.xlsx' : 'styles-import-template.xlsx'
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.send(buffer)
})

router.post('/styles/import', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { fileName, file, confirm } = importBody.parse(req.body)
  const rows = await styleImport.readSheet(Buffer.from(file, 'base64'), fileName)
  const plans = await styleImport.planImport(rows)
  const summary = {
    rows: plans.length,
    newStyles: plans.filter((p) => p.create).length,
    existing: plans.filter((p) => p.plan.style === 'existing').length,
    skipped: plans.filter((p) => p.plan.skipped).length,
    problems: plans.filter((p) => p.plan.problems.length > 0).length,
  }
  if (!confirm) {
    return res.json({ success: true, data: { summary, rows: plans.map((p) => p.plan) } })
  }

  const created = await styleImport.runImport(plans)
  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'StyleImport',
    entityId: `IMPORT-${Date.now()}`,
    after: { fileName, created },
  })
  res.status(201).json({
    success: true,
    message: created.length
      ? `Imported ${created.length} new ${created.length === 1 ? 'style' : 'styles'}.`
      : 'Nothing to import: every style is already in the system.',
    data: { summary, created },
  })
})

/*
 * What a style's BOMs stand on, checked before the style is saved.
 *
 * A BOM gives quantities per size of the style's size run, and is made for one
 * of the style's colours. Changing the size run left every such BOM pointing at
 * sizes the style no longer has, and the next save of any of them failed with
 * "Size 40 is not in the size run"; taking a colour off left its BOM for a
 * colour that no longer existed. Both are refused while a live BOM relies on
 * them. Ahead of the CRUD router, so the shared CRUD code is left alone.
 */
router.patch('/styles/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, _res, next) => {
  const style = await prisma.style.findUnique({
    where: { id: req.params.id },
    select: { code: true, sizeGroupId: true, colors: true },
  })
  if (!style) return next()
  const body = (req.body ?? {}) as { sizeGroupId?: string | null; colors?: unknown }
  const live = { styleId: req.params.id, status: { not: 'OBSOLETE' as const } }

  if (body.sizeGroupId !== undefined && (body.sizeGroupId || null) !== style.sizeGroupId) {
    const sized = await prisma.bOM.count({
      where: {
        ...live,
        OR: [{ baseSizeId: { not: null } }, { lines: { some: { sizes: { some: {} } } } }],
      },
    })
    if (sized > 0) {
      throw new AppError(
        `${sized} ${sized === 1 ? 'BOM' : 'BOMs'} for ${style.code} ${sized === 1 ? 'gives' : 'give'} quantities by size in the current size run. Changing the run would leave them pointing at sizes the style no longer has. Clear their per-size quantities first, or make a new style for the new run.`,
        409,
        'STYLE_SIZE_RUN_IN_USE',
      )
    }
  }

  if (Array.isArray(body.colors)) {
    const kept = new Set(body.colors.map((c) => String(c).trim().toLowerCase()))
    const removed = style.colors.filter((c) => !kept.has(c.trim().toLowerCase()))
    if (removed.length > 0) {
      const boms = await prisma.bOM.findMany({
        where: { ...live, color: { in: removed } },
        select: { color: true, version: true },
      })
      if (boms.length > 0) {
        const named = [...new Set(boms.map((b) => b.color))].join(', ')
        throw new AppError(
          `${style.code} has a BOM for ${named}. Retire that BOM before taking the colour off the style.`,
          409,
          'STYLE_COLOUR_IN_USE',
        )
      }
    }
  }
  next()
})

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
    filters: {
      brandType: { where: (v) => ({ brandType: { in: v } }), facets: ['brandType'] },
      category: textFilter('category'),
      season: textFilter('season'),
      fabricType: textFilter('fabricType'),
      fit: textFilter('fit'),
      sizeGroupId: {
        where: (v) => {
          const ids = v.filter((x) => x !== 'none')
          const or: Record<string, unknown>[] = []
          if (ids.length) or.push({ sizeGroupId: { in: ids } })
          if (v.includes('none')) or.push({ sizeGroupId: null })
          return { OR: or }
        },
        facets: ['sizeGroupId'],
      },
      // Styles made in any of the colours picked.
      colour: {
        where: (v) => {
          const colours = v.filter((x) => x !== 'none')
          const or: Record<string, unknown>[] = []
          if (colours.length) or.push({ colors: { hasSome: colours } })
          if (v.includes('none')) or.push({ colors: { isEmpty: true } })
          return { OR: or }
        },
        facets: ['colour'],
      },
    },
    facets: ['brandType', 'category', 'season', 'fabricType', 'fit', 'sizeGroupId', 'colour'],
    // Colours are a list on each style, so they are counted one by one: a
    // style in White and Navy counts once under each.
    customFacets: {
      colour: async (where) => {
        const rows = await prisma.style.findMany({ where, select: { colors: true } })
        const counts: Record<string, number> = {}
        for (const r of rows) {
          for (const c of new Set(r.colors.map((x) => x.trim()).filter(Boolean))) counts[c] = (counts[c] ?? 0) + 1
          if (r.colors.length === 0) counts.none = (counts.none ?? 0) + 1
        }
        return counts
      },
    },
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

/*
 * What else points at a store, beyond the relations this schema declares.
 * Other branches' tables (customer GRNs, job-work challans, purchase
 * returns, enquiries) hold store ids in the one shared database, and an
 * enquiry's would even be cleared without a word. Each is counted by name,
 * and a table not in this database is simply passed over.
 */
const WAREHOUSE_OTHER_USES: Array<{ table: string; columns: string[]; one: string; many: string }> = [
  { table: 'customer_grn', columns: ['warehouseId'], one: 'customer goods receipt', many: 'customer goods receipts' },
  { table: 'job_work_challans', columns: ['fromWarehouseId', 'toWarehouseId'], one: 'job-work challan', many: 'job-work challans' },
  { table: 'job_work_return_lines', columns: ['warehouseId'], one: 'job-work return line', many: 'job-work return lines' },
  { table: 'purchase_return_lines', columns: ['warehouseId'], one: 'purchase return line', many: 'purchase return lines' },
  { table: 'purchase_enquiries', columns: ['locationId'], one: 'purchase enquiry', many: 'purchase enquiries' },
]

async function warehouseOtherUses(id: string): Promise<string[]> {
  // Which of the tables this database has, asked once; then all counted together.
  const present = await prisma.$queryRawUnsafe<Array<{ t: string }>>(
    `select table_name as t from information_schema.tables where table_schema = 'ld_erp' and table_name = any($1)`,
    WAREHOUSE_OTHER_USES.map((u) => u.table),
  )
  const have = new Set(present.map((r) => r.t))
  const counts = await Promise.all(
    WAREHOUSE_OTHER_USES.filter((u) => have.has(u.table)).map(async (use) => {
      const where = use.columns.map((c) => `"${c}" = $1`).join(' or ')
      const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `select count(*) as n from ld_erp."${use.table}" where ${where}`,
        id,
      )
      const n = Number(row?.n ?? 0)
      return n > 0 ? `${n} ${n === 1 ? use.one : use.many}` : null
    }),
  )
  return counts.filter((c): c is string => Boolean(c))
}

const WAREHOUSE_REFUSE = (one: string, many: string): DeleteUse => ({ one, many, then: 'refuse' })
/** Everything that records goods in, out of or held at a store: none of it can lose its store. */
const WAREHOUSE_USES: Record<string, DeleteUse> = {
  stockLedger: WAREHOUSE_REFUSE('stock entry', 'stock entries'),
  grnLines: WAREHOUSE_REFUSE('goods receipt line', 'goods receipt lines'),
  mrLines: WAREHOUSE_REFUSE('material requisition line', 'material requisition lines'),
  transfersOut: WAREHOUSE_REFUSE('transfer out', 'transfers out'),
  transfersIn: WAREHOUSE_REFUSE('transfer in', 'transfers in'),
  adjustments: WAREHOUSE_REFUSE('stock adjustment', 'stock adjustments'),
  purchaseOrders: WAREHOUSE_REFUSE('purchase order delivering here', 'purchase orders delivering here'),
  purchaseNotes: WAREHOUSE_REFUSE('purchase note', 'purchase notes'),
  supplierPayments: WAREHOUSE_REFUSE('supplier payment', 'supplier payments'),
}

/*
 * Deleting a store for good. Its stock history says where goods physically
 * were, so nothing that uses it is ever moved or cleared: moving the ledger
 * to another store would make both stores' stock wrong. A store is deleted
 * only when nothing at all uses it; otherwise it is deactivated instead.
 * These two run ahead of the CRUD to add the other branches' tables to what
 * the CRUD counts itself.
 */
router.get('/warehouses/:id/delete-check', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const [store, others] = await Promise.all([
    prisma.warehouse.findUnique({
      where: { id: req.params.id },
      select: { _count: { select: Object.fromEntries(Object.keys(WAREHOUSE_USES).map((k) => [k, true])) } },
    }),
    warehouseOtherUses(req.params.id),
  ])
  if (!store) throw new AppError('Warehouse not found', 404, 'NOT_FOUND')
  const counts = store._count as Record<string, number>
  const own = Object.entries(WAREHOUSE_USES)
    .filter(([key]) => counts[key] > 0)
    .map(([key, use]) => `${counts[key]} ${counts[key] === 1 ? use.one : use.many}`)
  res.json({ success: true, data: { move: [], blank: [], refuse: [...own, ...others] } })
})
router.delete('/warehouses/:id', requirePermission(MODULE, 'delete'), async (req: AuthRequest, _res, next) => {
  if (req.query.permanent !== 'true') return next()
  const others = await warehouseOtherUses(req.params.id)
  if (others.length) {
    const store = await prisma.warehouse.findUnique({ where: { id: req.params.id }, select: { name: true } })
    throw new AppError(
      `${store?.name ?? 'This store'} is used by ${others.join(', ')}, so it cannot be deleted. Deactivate it instead.`,
      409,
      'IN_USE',
    )
  }
  next()
})


router.use(
  '/warehouses',
  crudRouter({
    model: 'warehouse',
    module: MODULE,
    entityType: 'Warehouse',
    createSchema: createWarehouseSchema,
    updateSchema: updateWarehouseSchema,
    // No two with the same name (ignoring capitals and spaces).
    uniqueFields: ['name'],
    injectOnCreate: currentCompanyId,
    searchFields: ['name', 'code'],
    sortableFields: ['name', 'code'],
    defaultSort: { field: 'name', order: 'asc' },
    // Any of it stops a delete; nothing is moved or cleared.
    permanentDelete: WAREHOUSE_USES,
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
    entityType: 'Unit',
    permanentDelete: UOM_USES,
    createSchema: createUomSchema,
    updateSchema: updateUomSchema,
    searchFields: ['name', 'symbol'],
    sortableFields: ['name', 'symbol'],
    defaultSort: { field: 'name', order: 'asc' },
    // How many items are counted in each unit, so nobody switches off Meter
    // without seeing how many items are bought in it.
    include: { _count: { select: { items: true } } },
    // Units are mostly added from inside an item form, by whoever is typing,
    // so "Mtr" and "mtr" must not become two units. Name and symbol are each
    // unique, ignoring case, and a clash is said under the box it is in.
    beforeSave: async (data, before) => {
      for (const key of ['name', 'symbol'] as const) {
        const value = data[key]
        if (typeof value !== 'string' || !value) continue
        const same = { equals: value, mode: 'insensitive' as const }
        const clash = await prisma.uOM.findFirst({
          where: {
            ...(key === 'name' ? { name: same } : { symbol: same }),
            ...(before?.id ? { id: { not: String(before.id) } } : {}),
          },
          select: { name: true, symbol: true, isActive: true },
        })
        if (!clash) continue
        const off = clash.isActive ? '' : ' It is switched off; edit it to bring it back.'
        const message =
          key === 'name'
            ? `There is already a unit called ${clash.name} (${clash.symbol}).${off}`
            : `${clash.symbol} is already the symbol of ${clash.name}.${off}`
        throw new ZodError([{ code: 'custom', path: [key], message }])
      }
      return { data }
    },
  }),
)

/*
 * HSN / SAC codes and the GST each carries.
 *
 * "Fill from items" starts the list off from the codes the item master
 * already uses, taking the rate those items carry. A code whose items
 * disagree (two rates on one code) or carry no rate at all is listed back
 * instead of guessed, for someone who knows to add by hand. Nothing is ever
 * overwritten: a code already in the list is left as it is.
 *
 * Ahead of the CRUD router, whose routes would otherwise take "from-items".
 */
router.post('/hsn-codes/from-items', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const [items, listed] = await Promise.all([
    prisma.item.findMany({
      where: { isActive: true, hsnCode: { not: null } },
      select: {
        name: true,
        hsnCode: true,
        taxRate: { select: { rate: true } },
        category: { select: { name: true, parent: { select: { name: true } } } },
      },
    }),
    prisma.hsnCode.findMany({ select: { code: true } }),
  ])
  const index = await loadHsnIndex(prisma)
  const known = new Set(listed.map((h) => h.code))

  const byCode = new Map<string, typeof items>()
  for (const it of items) {
    const code = (it.hsnCode ?? '').replace(/\s+/g, '')
    if (!code) continue
    byCode.set(code, [...(byCode.get(code) ?? []), it])
  }

  const created: Array<{ code: string; gstRate: number; description: string }> = []
  const skipped: Array<{ code: string; reason: string; items: number }> = []
  for (const [code, group] of [...byCode.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (known.has(code)) continue
    if (!/^[0-9]{4,8}$/.test(code)) {
      skipped.push({ code, reason: 'not 4 to 8 digits — correct it on the item', items: group.length })
      continue
    }
    const heading = findHsn(index, code)
    if (heading) {
      skipped.push({ code, reason: `already covered by ${heading.code}`, items: group.length })
      continue
    }
    const rates = [...new Set(group.filter((g) => g.taxRate).map((g) => Number(g.taxRate!.rate)))].sort((a, b) => a - b)
    if (rates.length === 0) {
      skipped.push({ code, reason: 'no item with this code has a GST rate', items: group.length })
      continue
    }
    if (rates.length > 1) {
      skipped.push({ code, reason: `its items carry ${rates.map((r) => r + '%').join(' and ')}`, items: group.length })
      continue
    }
    const names = [...new Set(group.map((g) => g.category?.name ?? g.name))]
    const description = names.join(', ').slice(0, 300)
    await prisma.hsnCode.create({
      data: { code, description, kind: code.startsWith('99') ? 'SERVICES' : 'GOODS', gstRate: rates[0] },
    })
    created.push({ code, gstRate: rates[0], description })
  }

  if (created.length) {
    await writeAuditLog(req, {
      module: MODULE,
      action: 'CREATE',
      entityType: 'HsnCode',
      entityId: 'from-items',
      after: { created },
    })
  }
  res.json({ success: true, data: { created, skipped } })
})

/*
 * Masters → Dropdown Lists: the small lists the mill keeps for itself, one
 * table and one page for all of them. Names are unique within their list,
 * without regard to capitals, so the same reason cannot be offered twice.
 */
router.use(
  '/dropdown-values',
  crudRouter({
    model: 'dropdownValue',
    module: MODULE,
    entityType: 'DropdownValue',
    createSchema: createDropdownValueSchema,
    updateSchema: updateDropdownValueSchema,
    searchFields: ['label'],
    sortableFields: ['label', 'sortOrder', 'createdAt'],
    defaultSort: { field: 'label', order: 'asc' },
    filters: {
      list: { where: (v) => ({ list: { in: v } }) },
    },
    beforeSave: async (data, before) => {
      const list = String(data.list ?? before?.list ?? 'RETURN_REASON')
      const label = String(data.label ?? before?.label ?? '').trim()
      const clash = await prisma.dropdownValue.findFirst({
        where: {
          list,
          label: { equals: label, mode: 'insensitive' },
          ...(before?.id ? { id: { not: String(before.id) } } : {}),
        },
        select: { label: true, isActive: true },
      })
      if (clash) {
        throw new AppError(
          `There is already one called "${clash.label}"${clash.isActive ? '' : ' (switched off — edit it to bring it back)'}.`,
          409,
          'DUPLICATE'
        )
      }
      return { data }
    },
  }),
)

router.use(
  '/hsn-codes',
  crudRouter({
    model: 'hsnCode',
    module: MODULE,
    entityType: 'HsnCode',
    createSchema: createHsnCodeSchema,
    updateSchema: updateHsnCodeSchema,
    uniqueFields: ['code'],
    searchFields: ['code', 'description', 'notes'],
    sortableFields: ['code', 'description', 'gstRate', 'createdAt'],
    defaultSort: { field: 'code', order: 'asc' },
    filters: {
      kind: { where: (v) => ({ kind: { in: v.filter((k) => k === 'GOODS' || k === 'SERVICES') } }), facets: ['kind'] },
    },
    facets: ['kind'],
  }),
)

/*
 * Two levels, main category and sub-category, and never a loop.
 *
 * A category could be made its own parent, or A put under B under A, and the
 * list then read "Cat A / Cat A"; a sub-category could go under another
 * sub-category, which no item picker offers. So the parent has to be a main
 * category, not the category itself, and a main category that has
 * sub-categories cannot itself be moved under another. Ahead of the CRUD.
 */
async function checkCategoryParent(req: AuthRequest, _res: unknown, next: (err?: unknown) => void) {
  const parentId = (req.body ?? {}).parentId as string | null | undefined
  if (!parentId) return next()
  const selfId = req.params.id as string | undefined
  if (selfId && parentId === selfId) {
    throw new ZodError([{ code: 'custom', path: ['parentId'], message: 'A category cannot sit under itself.' }])
  }
  const parent = await prisma.itemCategory.findUnique({
    where: { id: parentId },
    select: { name: true, parentId: true },
  })
  if (!parent) {
    throw new ZodError([{ code: 'custom', path: ['parentId'], message: 'That category no longer exists.' }])
  }
  if (parent.parentId) {
    throw new ZodError([
      {
        code: 'custom',
        path: ['parentId'],
        message: `${parent.name} is itself a sub-category. Pick a main category.`,
      },
    ])
  }
  if (selfId) {
    const children = await prisma.itemCategory.count({ where: { parentId: selfId } })
    if (children > 0) {
      throw new ZodError([
        {
          code: 'custom',
          path: ['parentId'],
          message: `This category has ${children} sub-${children === 1 ? 'category' : 'categories'} of its own, so it has to stay a main category.`,
        },
      ])
    }
  }
  next()
}
router.post('/item-categories', requirePermission(MODULE, 'create'), checkCategoryParent)
router.patch('/item-categories/:id', requirePermission(MODULE, 'edit'), checkCategoryParent)

/*
 * Categories from a spreadsheet, the same way as items: check first, then all
 * or nothing. It makes categories and sets their departments; it never
 * touches an item. Ahead of the CRUD, for the same reason as the items one.
 */
router.get('/item-categories/import-template', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const withCurrent = req.query.withCurrent === 'true'
  const buffer = await categoryImport.buildTemplate(withCurrent)
  const name = withCurrent ? 'categories-with-current-list.xlsx' : 'categories-import-template.xlsx'
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.send(buffer)
})

router.post('/item-categories/import', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { fileName, file, confirm } = importBody.parse(req.body)
  const rows = await categoryImport.readSheet(Buffer.from(file, 'base64'), fileName)
  const plans = await categoryImport.planImport(rows)

  // Changing the department of a category already there is an edit.
  if (plans.some((p) => p.setDepartment) && !userCan(req.user, MODULE, 'edit')) {
    throw new AppError(
      'This sheet changes the department of categories already in the system, and your role cannot edit them. Leave Department empty on those rows.',
      403,
      'NO_EDIT_RIGHT',
    )
  }

  const summary = {
    rows: plans.length,
    newMains: plans.filter((p) => p.newMain).length,
    newSubs: plans.filter((p) => p.newSub).length,
    departmentsSet: plans.filter((p) => p.setDepartment).length,
    skipped: plans.filter((p) => p.plan.skipped).length,
    problems: plans.filter((p) => p.plan.problems.length > 0).length,
  }

  if (!confirm) {
    return res.json({ success: true, data: { summary, rows: plans.map((p) => p.plan) } })
  }

  const done = await categoryImport.runImport(plans)
  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'ItemCategoryImport',
    entityId: `IMPORT-${Date.now()}`,
    after: { fileName, created: done.made, departmentsSet: done.departmentsSet },
  })
  const parts = [
    done.mains ? `${done.mains} new ${done.mains === 1 ? 'category' : 'categories'}` : '',
    done.subs ? `${done.subs} new ${done.subs === 1 ? 'sub-category' : 'sub-categories'}` : '',
    done.departmentsSet ? `${done.departmentsSet} ${done.departmentsSet === 1 ? 'department' : 'departments'} set` : '',
  ].filter(Boolean)
  res.status(201).json({
    success: true,
    message: parts.length
      ? `Imported ${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ' and ' : ''}${parts[parts.length - 1]}.`
      : 'Nothing to import: every row is already in the system.',
    data: { summary, created: done.made, departmentsSet: done.departmentsSet },
  })
})

router.use(
  '/item-categories',
  crudRouter({
    model: 'itemCategory',
    module: MODULE,
    entityType: 'ItemCategory',
    createSchema: createItemCategorySchema,
    updateSchema: updateItemCategorySchema,
    // No two with the same name (ignoring capitals and spaces).
    uniqueFields: ['name'],
    // "fabric" finds Fabric's sub-categories too.
    searchFields: ['name', 'parent.name'],
    filters: {
      // A main category, with everything under it.
      categoryId: {
        where: (v) => ({ OR: [{ id: { in: v } }, { parentId: { in: v } }] }),
        facets: ['parentId'],
      },
      level: {
        where: (v) =>
          v.includes('main') && v.includes('sub')
            ? {}
            : v.includes('main')
              ? { parentId: null }
              : { parentId: { not: null } },
        facets: ['parentId'],
      },
      // A category's own department, or, for a main category, any of its
      // sub-categories'. 'none' is a category with none set.
      departmentId: {
        where: (v) => {
          const ids = v.filter((x) => x !== 'none')
          const or: Record<string, unknown>[] = []
          if (ids.length) {
            or.push({ departmentId: { in: ids } }, { children: { some: { departmentId: { in: ids } } } })
          }
          if (v.includes('none')) or.push({ departmentId: null, children: { none: { departmentId: { not: null } } } })
          return { OR: or }
        },
        facets: ['departmentId'],
      },
    },
    facets: ['parentId', 'departmentId'],
    /*
     * Deleting for good. An item must have a category, so its items move to
     * the one the person picks. A main category with sub-categories under it
     * is refused until they are deleted or moved: taking them along to another
     * category, unasked, would re-file every item beneath them.
     */
    permanentDelete: {
      children: { one: 'sub-category', many: 'sub-categories', then: 'refuse' },
      items: { one: 'item', many: 'items', model: 'item', field: 'categoryId', then: 'move' },
    },
    // Counted the way the filter matches: a category counts once for its own
    // department and each of its sub-categories', so "Cutting 9" is Fabric
    // and its eight sub-categories, the nine rows the filter then shows.
    customFacets: {
      departmentId: async (where) => {
        const rows = await prisma.itemCategory.findMany({
          where,
          select: { departmentId: true, children: { select: { departmentId: true } } },
        })
        const counts: Record<string, number> = {}
        for (const r of rows) {
          const depts = new Set(
            [r.departmentId, ...r.children.map((c) => c.departmentId)].filter((d): d is string => Boolean(d)),
          )
          if (depts.size === 0) counts.none = (counts.none ?? 0) + 1
          for (const d of depts) counts[d] = (counts[d] ?? 0) + 1
        }
        return counts
      },
    },
    sortableFields: ['name'],
    defaultSort: { field: 'name', order: 'asc' },
    include: {
      parent: true,
      department: { select: { id: true, name: true } },
      children: { include: { department: { select: { id: true, name: true } } } },
    },
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
    // "xl" finds every run with an XL in it.
    searchFields: ['name', 'sizes.some.label'],
    sortableFields: ['name'],
    defaultSort: { field: 'name', order: 'asc' },
    include: { sizes: { orderBy: { sequence: 'asc' } }, _count: { select: { styles: true } } },
    filters: {
      gender: {
        where: (v) => {
          const values = v.filter((x) => x !== 'none')
          const or: Record<string, unknown>[] = []
          if (values.length) or.push({ gender: { in: values } })
          if (v.includes('none')) or.push({ gender: null })
          return { OR: or }
        },
        facets: ['gender'],
      },
      // Runs holding any of the sizes picked.
      size: { where: (v) => ({ sizes: { some: { label: { in: v } } } }), facets: ['size'] },
      // Whether any style is cut in it.
      use: {
        where: (v) =>
          v.includes('used') && v.includes('unused')
            ? {}
            : v.includes('used')
              ? { styles: { some: {} } }
              : { styles: { none: {} } },
        facets: ['use'],
      },
    },
    facets: ['gender', 'size', 'use'],
    customFacets: {
      size: async (where) => {
        const rows = await prisma.sizeGroup.findMany({ where, select: { sizes: { select: { label: true } } } })
        const counts: Record<string, number> = {}
        for (const r of rows) for (const l of new Set(r.sizes.map((x) => x.label))) counts[l] = (counts[l] ?? 0) + 1
        return counts
      },
      use: async (where) => {
        const [used, unused] = await Promise.all([
          prisma.sizeGroup.count({ where: { AND: [where, { styles: { some: {} } }] } }),
          prisma.sizeGroup.count({ where: { AND: [where, { styles: { none: {} } }] } }),
        ])
        return { used, unused }
      },
    },
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
    // Sizes have no active flag: one is deleted, never deactivated. But order,
    // manufacturing order and BOM lines point at the size itself, so one in
    // use cannot go: its lines would lose their size (or a BOM its base size,
    // silently). The delete says what uses it instead.
    softDelete: false,
    permanentDelete: {
      soLineSizes: { one: 'sales order line', many: 'sales order lines', then: 'refuse' },
      moLineSizes: { one: 'manufacturing order line', many: 'manufacturing order lines', then: 'refuse' },
      bomLineSizes: { one: 'BOM line', many: 'BOM lines', then: 'refuse' },
      baseSizeBoms: { one: 'BOM as its base size', many: 'BOMs as their base size', then: 'refuse' },
    },
    filters: {
      sizeGroupId: { where: (v) => ({ sizeGroupId: { in: v } }), facets: ['sizeGroupId'] },
    },
    facets: ['sizeGroupId'],
    include: { sizeGroup: { select: { id: true, name: true } } },
  }),
)

/*
 * Workstations from a spreadsheet, as the other masters: check first, then
 * all or nothing. New stations only; one already there is skipped. Ahead of
 * the CRUD, whose GET /:id would otherwise take "import-template" for an id.
 */
router.get('/workstations/import-template', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const withCurrent = req.query.withCurrent === 'true'
  const buffer = await workstationImport.buildTemplate(withCurrent)
  const name = withCurrent ? 'workstations-with-current-list.xlsx' : 'workstations-import-template.xlsx'
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.send(buffer)
})

router.post('/workstations/import', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { fileName, file, confirm } = importBody.parse(req.body)
  const rows = await workstationImport.readSheet(Buffer.from(file, 'base64'), fileName)
  const plans = await workstationImport.planImport(rows)
  const summary = {
    rows: plans.length,
    newWorkstations: plans.filter((p) => p.create).length,
    existing: plans.filter((p) => p.plan.workstation === 'existing').length,
    skipped: plans.filter((p) => p.plan.skipped).length,
    problems: plans.filter((p) => p.plan.problems.length > 0).length,
  }
  if (!confirm) {
    return res.json({ success: true, data: { summary, rows: plans.map((p) => p.plan) } })
  }

  const created = await workstationImport.runImport(plans)
  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'WorkstationImport',
    entityId: `IMPORT-${Date.now()}`,
    after: { fileName, created },
  })
  res.status(201).json({
    success: true,
    message: created.length
      ? `Imported ${created.length} new ${created.length === 1 ? 'workstation' : 'workstations'}.`
      : 'Nothing to import: every workstation is already in the system.',
    data: { summary, created },
  })
})

/*
 * An outside unit has to name the supplier we pay, or its job-work bill can
 * never be totalled. The form for a new one checks it; an edit sends only
 * what changed, so here the change is read together with what is on file:
 * switching a station to an outside unit, or clearing its supplier, is
 * refused unless a supplier is left on it. Ahead of the CRUD.
 */
router.patch('/workstations/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, _res, next) => {
  const body = (req.body ?? {}) as { type?: string; supplierId?: string | null }
  if (!('type' in body) && !('supplierId' in body)) return next()
  const before = await prisma.workstation.findUnique({
    where: { id: req.params.id },
    select: { type: true, supplierId: true },
  })
  if (!before) return next()
  const type = body.type ?? before.type
  const supplierId = 'supplierId' in body ? body.supplierId : before.supplierId
  if (type === 'JOB_WORK' && !supplierId) {
    throw new ZodError([
      { code: 'custom', path: ['supplierId'], message: 'A job-work unit must be linked to the supplier you pay for it' },
    ])
  }
  next()
})

router.use(
  '/workstations',
  crudRouter({
    model: 'workstation',
    module: MODULE,
    entityType: 'Workstation',
    createSchema: createWorkstationSchema,
    updateSchema: updateWorkstationSchema,
    // No two with the same name (ignoring capitals and spaces).
    uniqueFields: ['name'],
    searchFields: ['name', 'code', 'contactPerson', 'department.name', 'supplier.name'],
    sortableFields: ['name', 'code', 'createdAt', 'capacityPerDay'],
    defaultSort: { field: 'code', order: 'asc' },
    include: {
      department: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true } },
      _count: { select: { routingSteps: true } },
    },
    filters: {
      departmentId: { where: (v) => ({ departmentId: { in: v } }), facets: ['departmentId'] },
      type: { where: (v) => ({ type: { in: v } }), facets: ['type'] },
      supplierId: {
        where: (v) => {
          const ids = v.filter((x) => x !== 'none')
          const or: Record<string, unknown>[] = []
          if (ids.length) or.push({ supplierId: { in: ids } })
          if (v.includes('none')) or.push({ supplierId: null })
          return { OR: or }
        },
        facets: ['supplierId'],
      },
      capacity: {
        where: (v) =>
          v.includes('set') && v.includes('unset')
            ? {}
            : v.includes('set')
              ? { capacityPerDay: { not: null } }
              : { capacityPerDay: null },
        facets: ['capacity'],
      },
      // Whether any routing sends work to it.
      routings: {
        where: (v) =>
          v.includes('used') && v.includes('unused')
            ? {}
            : v.includes('used')
              ? { routingSteps: { some: {} } }
              : { routingSteps: { none: {} } },
        facets: ['routings'],
      },
    },
    facets: ['departmentId', 'type', 'supplierId', 'capacity', 'routings'],
    customFacets: {
      capacity: async (where) => {
        const [set, unset] = await Promise.all([
          prisma.workstation.count({ where: { AND: [where, { capacityPerDay: { not: null } }] } }),
          prisma.workstation.count({ where: { AND: [where, { capacityPerDay: null }] } }),
        ])
        return { set, unset }
      },
      routings: async (where) => {
        const [used, unused] = await Promise.all([
          prisma.workstation.count({ where: { AND: [where, { routingSteps: { some: {} } }] } }),
          prisma.workstation.count({ where: { AND: [where, { routingSteps: { none: {} } }] } }),
        ])
        return { used, unused }
      },
    },
    exportSheet: {
      fileName: 'workstations',
      build: (rows) => workstationImport.workstationWorkbook(rows, false),
    },
  }),
)

/*
 * Agents from a spreadsheet, as customers and suppliers: check first, then
 * all or nothing. New agents only; one already there is skipped. Ahead of
 * the CRUD, whose GET /:id would otherwise take "import-template" for an id.
 */
router.get('/brokers/import-template', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const withCurrent = req.query.withCurrent === 'true'
  const buffer = await brokerImport.buildTemplate(withCurrent)
  const name = withCurrent ? 'agents-with-current-list.xlsx' : 'agents-import-template.xlsx'
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.send(buffer)
})

router.post('/brokers/import', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { fileName, file, confirm } = importBody.parse(req.body)
  const rows = await brokerImport.readSheet(Buffer.from(file, 'base64'), fileName)
  const plans = await brokerImport.planImport(rows)
  const summary = {
    rows: plans.length,
    newAgents: plans.filter((p) => p.create).length,
    existing: plans.filter((p) => p.plan.broker === 'existing').length,
    skipped: plans.filter((p) => p.plan.skipped).length,
    problems: plans.filter((p) => p.plan.problems.length > 0).length,
  }
  if (!confirm) {
    return res.json({ success: true, data: { summary, rows: plans.map((p) => p.plan) } })
  }

  const created = await brokerImport.runImport(plans)
  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'BrokerImport',
    entityId: `IMPORT-${Date.now()}`,
    after: { fileName, created },
  })
  res.status(201).json({
    success: true,
    message: created.length
      ? `Imported ${created.length} new ${created.length === 1 ? 'agent' : 'agents'}.`
      : 'Nothing to import: every agent is already in the system.',
    data: { summary, created },
  })
})

router.use(
  '/brokers',
  crudRouter({
    model: 'broker',
    module: MODULE,
    entityType: 'Broker',
    createSchema: createBrokerSchema,
    updateSchema: updateBrokerSchema,
    // No two with the same name (ignoring capitals and spaces), nor the same GSTIN.
    uniqueFields: ['name', 'gstin'],
    searchFields: ['name', 'code', 'phone', 'email', 'city'],
    sortableFields: ['name', 'code', 'brokeragePercent'],
    defaultSort: { field: 'name', order: 'asc' },
    // How many customers each one brings, for the list and its filter.
    include: { _count: { select: { customers: true } } },
    filters: {
      // By the GST state code, not the typed name: the agents on file have the
      // code but were saved before the name was filled in from it.
      stateCode: textFilter('stateCode'),
      city: textFilter('city'),
      brokeragePercent: {
        where: (v) => ({ brokeragePercent: { in: v.map(Number).filter(Number.isFinite) } }),
        facets: ['brokeragePercent'],
      },
      tdsSection: textFilter('tdsSection'),
      // Registered for GST or not: a registered agent bills GST on the commission.
      gst: {
        where: (v) =>
          v.includes('registered') && v.includes('unregistered')
            ? {}
            : v.includes('registered')
              ? { AND: [{ gstin: { not: null } }, { gstin: { not: '' } }] }
              : { OR: [{ gstin: null }, { gstin: '' }] },
        facets: ['gst'],
      },
      // Whether any customer comes through them.
      customers: {
        where: (v) =>
          v.includes('with') && v.includes('without')
            ? {}
            : v.includes('with')
              ? { customers: { some: {} } }
              : { customers: { none: {} } },
        facets: ['customers'],
      },
    },
    facets: ['stateCode', 'city', 'brokeragePercent', 'tdsSection', 'gst', 'customers'],
    customFacets: {
      gst: async (where) => {
        const [registered, unregistered] = await Promise.all([
          prisma.broker.count({ where: { AND: [where, { gstin: { not: null } }, { gstin: { not: '' } }] } }),
          prisma.broker.count({ where: { AND: [where, { OR: [{ gstin: null }, { gstin: '' }] }] } }),
        ])
        return { registered, unregistered }
      },
      customers: async (where) => {
        const [withCustomers, without] = await Promise.all([
          prisma.broker.count({ where: { AND: [where, { customers: { some: {} } }] } }),
          prisma.broker.count({ where: { AND: [where, { customers: { none: {} } }] } }),
        ])
        return { with: withCustomers, without }
      },
    },
    exportSheet: {
      fileName: 'agents',
      build: (rows) => brokerImport.brokerWorkbook(rows, false),
    },
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
    // No two with the same name (ignoring capitals and spaces).
    uniqueFields: ['name'],
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
    prisma.operation.findMany({
      where: { id: { in: operationIds } },
      select: { id: true, name: true, departmentId: true },
    }),
    prisma.department.findMany({ where: { id: { in: departmentIds } }, select: { id: true, name: true } }),
    workstationIds.length
      ? prisma.workstation.findMany({
          where: { id: { in: workstationIds } },
          select: { id: true, name: true, departmentId: true },
        })
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

  // A step is done by one department, with that department's operation on
  // that department's machine. A cutting operation booked to Accounts, on a
  // stitching workstation, used to save, and the floor's piece-rates and
  // loading were then worked out against the wrong department.
  // Names for every department involved, the operations' and workstations'
  // own as well as the steps', so a message can say which one it should be.
  const involved = [...new Set([...operations.map((o) => o.departmentId), ...workstations.map((w) => w.departmentId)])]
  const named = await prisma.department.findMany({ where: { id: { in: involved } }, select: { id: true, name: true } })
  const deptName = new Map([...departments, ...named].map((d) => [d.id, d.name]))
  const op = new Map(operations.map((o) => [o.id, o]))
  const ws = new Map(workstations.map((w) => [w.id, w]))
  steps.forEach((step, i) => {
    const here = deptName.get(step.departmentId) ?? 'this department'
    const o = op.get(step.operationId)!
    if (o.departmentId !== step.departmentId) {
      throw new AppError(
        `Step ${i + 1}: ${o.name} is a ${deptName.get(o.departmentId) ?? 'different department'} operation, not ${here}. Pick the department it belongs to, or another operation.`,
        400,
        'STEP_DEPARTMENT_MISMATCH',
      )
    }
    const w = step.workstationId ? ws.get(step.workstationId) : undefined
    if (w && w.departmentId !== step.departmentId) {
      throw new AppError(
        `Step ${i + 1}: ${w.name} is not a ${here} workstation. Pick one of ${here}'s, or leave it empty.`,
        400,
        'STEP_WORKSTATION_MISMATCH',
      )
    }
  })
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
  pricedBy: { select: { id: true, name: true } },
  costLines: {
    orderBy: { sortOrder: 'asc' as const },
    include: { department: { select: { id: true, code: true, name: true } } },
  },
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
async function priceBomLines(lines: IncomingBomLine[]) {
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

  return { priced, totalCost, warnings }
}

type IncomingCostLine = {
  kind: 'LABOUR' | 'OVERHEAD'
  name: string
  departmentId?: string | null
  basis: 'PER_PIECE' | 'PERCENT'
  value: number
}

/**
 * The cost of one garment, built up the way a costing sheet is: material, then
 * labour, then overhead — which may be a percentage of the two before it, as
 * "factory overhead 10%" usually is. Rounded to the paisa at every step, so the
 * build-up on screen adds up on a calculator.
 */
function costBom(material: number, rows: IncomingCostLine[]) {
  const labourRows = rows
    .filter((r) => r.kind === 'LABOUR')
    .map((r) => ({ ...r, amount: round(r.value, 2) }))
  const labourCost = round(
    labourRows.reduce((sum, r) => sum + r.amount, 0),
    2,
  )

  const base = round(material + labourCost, 2)
  const overheadRows = rows
    .filter((r) => r.kind === 'OVERHEAD')
    .map((r) => ({
      ...r,
      amount: r.basis === 'PERCENT' ? round((base * r.value) / 100, 2) : round(r.value, 2),
    }))
  const overheadCost = round(
    overheadRows.reduce((sum, r) => sum + r.amount, 0),
    2,
  )

  // Kept in the order they were typed, labour first, so the list reads the
  // same way the form does.
  const priced = [...labourRows, ...overheadRows].map((r, index) => ({
    kind: r.kind,
    name: r.name,
    departmentId: r.departmentId || null,
    basis: r.basis,
    value: round(r.value, 2),
    amount: r.amount,
    sortOrder: index,
  }))

  return {
    rows: priced,
    labourCost,
    overheadCost,
    costPerPiece: round(material + labourCost + overheadCost, 2),
  }
}

/**
 * Margin is a share of the selling price: at 20%, a ₹473.53 shirt sells for
 * 473.53 ÷ 0.80. Rounded to the paisa first, so a price that divides exactly is
 * not pushed up a rupee by floating-point dust, then up to the next rupee.
 */
const priceFromMargin = (cost: number, marginPercent: number) =>
  Math.ceil(round(cost / (1 - marginPercent / 100), 2))

/** The other way round, for a price typed straight in. */
const marginFromPrice = (cost: number, price: number) => round(((price - cost) / price) * 100, 2)

/** The rows as they are stored, turned back into what a save would send. */
const storedCostRows = (
  rows: Array<{
    kind: 'LABOUR' | 'OVERHEAD'
    name: string
    departmentId: string | null
    basis: 'PER_PIECE' | 'PERCENT'
    value: unknown
  }>,
): IncomingCostLine[] =>
  rows.map((r) => ({
    kind: r.kind,
    name: r.name,
    departmentId: r.departmentId,
    basis: r.basis,
    value: Number(r.value),
  }))

async function assertCostDepartmentsExist(rows: IncomingCostLine[] | undefined) {
  const ids = [
    ...new Set((rows ?? []).map((r) => r.departmentId).filter((d): d is string => Boolean(d))),
  ]
  if (ids.length === 0) return
  const found = await prisma.department.count({ where: { id: { in: ids } } })
  if (found !== ids.length) {
    throw new AppError('One of those departments no longer exists', 400, 'INVALID_DEPARTMENT')
  }
}

/**
 * Costing and pricing are for the people who may approve masters. Everyone
 * else still sees the materials and what they cost, but not labour, overhead,
 * margin or price — left out of the answer, not merely hidden on the screen.
 */
function forViewer<T extends object>(req: AuthRequest, bom: T): T {
  if (userCan(req.user, MODULE, 'approve')) return bom
  const {
    labourCost: _labour,
    overheadCost: _overhead,
    costPerPiece: _cost,
    marginPercent: _margin,
    sellingPrice: _price,
    pricedById: _pricedById,
    pricedBy: _pricedBy,
    pricedAt: _pricedAt,
    costLines: _costLines,
    ...rest
  } = bom as T & Record<string, unknown>
  return rest as T
}

/** Only an approver may write the costing a non-approver cannot even see. */
function assertMayCost(req: AuthRequest, costLines: unknown) {
  if (costLines !== undefined && !userCan(req.user, MODULE, 'approve')) {
    throw new AppError(
      'Only someone who can approve masters can enter labour and overhead costs.',
      403,
      'BOM_COSTING_FORBIDDEN',
    )
  }
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
 * A BOM is built from things still in use.
 *
 * A new BOM needs an active style, and any component not already on the BOM
 * has to be an active item: a deactivated style and a deactivated item both
 * used to be accepted, and approved. Components already on a BOM are left
 * alone, so a draft whose item was retired later can still be opened and the
 * item replaced.
 */
async function assertActiveForBom(
  styleId: string,
  lines: IncomingBomLine[] | undefined,
  alreadyOn: Set<string>,
  isNew: boolean,
): Promise<void> {
  if (isNew) {
    const style = await prisma.style.findUnique({
      where: { id: styleId },
      select: { code: true, isActive: true },
    })
    if (style && !style.isActive) {
      throw new AppError(
        `${style.code} is deactivated, so no new BOM can be made for it. Reactivate the style first.`,
        400,
        'BOM_STYLE_INACTIVE',
      )
    }
  }
  const added = [...new Set((lines ?? []).map((l) => l.componentItemId))].filter((id) => !alreadyOn.has(id))
  if (added.length === 0) return
  const retired = await prisma.item.findMany({
    where: { id: { in: added }, isActive: false },
    select: { name: true },
  })
  if (retired.length > 0) {
    throw new AppError(
      `${retired.map((i) => i.name).join(', ')} ${retired.length === 1 ? 'is' : 'are'} deactivated, so ${retired.length === 1 ? 'it' : 'they'} cannot go on a BOM.`,
      400,
      'BOM_COMPONENT_INACTIVE',
    )
  }
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

router.get('/bom', requirePermission(MODULE, 'view'), async (req: AuthRequest, res) => {
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
    data: rows.map((row) => forViewer(req, row)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/bom/:id', requirePermission(MODULE, 'view'), async (req: AuthRequest, res) => {
  const bom = await prisma.bOM.findUnique({ where: { id: req.params.id }, include: bomInclude })
  if (!bom) throw new AppError('BOM not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: forViewer(req, bom) })
})

router.post('/bom', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { lines, costLines, styleId, color, version, notes, isActive, routingId, baseSizeId } =
    createBomSchema.parse(req.body)
  assertMayCost(req, costLines)

  const colour = color?.trim() || null
  const style = await assertBomRefsExist(styleId, routingId, lines, baseSizeId, {
    value: colour,
    required: true,
  })
  await assertCostDepartmentsExist(costLines)
  await assertActiveForBom(styleId, lines, new Set(), true)

  const useVersion = version ?? '1.0'
  const typedVersion = version !== undefined
  await assertVersionFree(styleId, colour, useVersion, style.code, undefined, typedVersion)

  const { priced, totalCost, warnings } = await priceBomLines(lines)
  const costing = costBom(totalCost, costLines ?? [])

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
        labourCost: costing.labourCost,
        overheadCost: costing.overheadCost,
        costPerPiece: costing.costPerPiece,
        lines: { create: priced.map(toLineCreate) },
        ...(costing.rows.length > 0 ? { costLines: { create: costing.rows } } : {}),
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
    data: forViewer(req, created!),
  })
})

router.patch('/bom/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { lines, costLines, version, notes, isActive, routingId, baseSizeId } =
    updateBomSchema.parse(req.body)
  assertMayCost(req, costLines)

  const before = await prisma.bOM.findUnique({ where: { id: req.params.id }, include: bomInclude })
  if (!before) throw new AppError('BOM not found', 404, 'NOT_FOUND')

  // An approved BOM is what running orders are costed against. Changing its
  // components or its labour and overhead underneath them is the whole thing the
  // approval exists to stop; a new version starts from a copy instead. The price
  // has its own route and stays open. Deactivating is still allowed, because
  // that is how a master is retired.
  const changesCosting =
    lines !== undefined ||
    costLines !== undefined ||
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
    await assertCostDepartmentsExist(costLines)
    await assertActiveForBom(
      before.styleId,
      lines,
      new Set(before.lines.map((l) => l.componentItemId)),
      false,
    )
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
    const costs: {
      totalCost?: number
      labourCost?: number
      overheadCost?: number
      costPerPiece?: number
      sellingPrice?: number
    } = {}
    let material = Number(before.totalCost ?? 0)

    if (lines) {
      const repriced = await priceBomLines(lines)
      material = repriced.totalCost
      costs.totalCost = repriced.totalCost
      warnings = repriced.warnings

      await tx.bOMLine.deleteMany({ where: { bomId: before.id } })
      // Written one at a time on purpose: createMany cannot write the nested
      // size rows, and it fails silently rather than loudly — the lines save
      // and every size quietly disappears.
      for (const line of repriced.priced) {
        await tx.bOMLine.create({ data: { ...toLineCreate(line), bomId: before.id } })
      }
    }

    // New materials move the cost even when nobody touched the costing rows: a
    // percentage overhead is a share of the material. So the rows it already
    // has are worked out again, unless new ones were sent.
    if (lines || costLines) {
      const costing = costBom(material, costLines ?? storedCostRows(before.costLines))
      await tx.bOMCostLine.deleteMany({ where: { bomId: before.id } })
      if (costing.rows.length > 0) {
        await tx.bOMCostLine.createMany({
          data: costing.rows.map((r) => ({ ...r, bomId: before.id })),
        })
      }
      costs.labourCost = costing.labourCost
      costs.overheadCost = costing.overheadCost
      costs.costPerPiece = costing.costPerPiece
      // A draft's price follows its margin, because the margin is what was
      // chosen. Once approved the cost cannot move, so neither does this.
      if (before.marginPercent !== null && costing.costPerPiece > 0) {
        costs.sellingPrice = priceFromMargin(costing.costPerPiece, Number(before.marginPercent))
      }
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
    data: forViewer(req, updated),
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

    // Orders are costed against an approved BOM, so it may not rest on a style
    // or a component that has been retired.
    const retired = await prisma.item.findMany({
      where: { id: { in: before.lines.map((l) => l.componentItemId) }, isActive: false },
      select: { name: true },
    })
    const styleNow = await prisma.style.findUnique({
      where: { id: before.styleId },
      select: { isActive: true, code: true },
    })
    if (styleNow && !styleNow.isActive) {
      throw new AppError(
        `${styleNow.code} is deactivated, so a BOM for it cannot be approved.`,
        409,
        'BOM_STYLE_INACTIVE',
      )
    }
    if (retired.length > 0) {
      throw new AppError(
        `${retired.map((i) => i.name).join(', ')} ${retired.length === 1 ? 'is' : 'are'} deactivated. Replace ${retired.length === 1 ? 'it' : 'them'} on the BOM before approving.`,
        409,
        'BOM_COMPONENT_INACTIVE',
      )
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
      data: forViewer(req, after),
    })
  },
)

/**
 * The price is the one part of a BOM that stays open after approval. The cost
 * is a fact about how the garment is made, and approval freezes it; the price
 * is a commercial call that moves with each buyer. Every change is audited, so
 * the history of a style's price is in the log.
 *
 * Takes a margin, which works the price out, or a price typed straight in,
 * which works the margin back. A price below cost is allowed — a loss leader
 * is a decision somebody may make — but not one below half the cost, which is
 * a typing mistake far more often than a strategy.
 */
router.patch(
  '/bom/:id/price',
  requirePermission(MODULE, 'approve'),
  async (req: AuthRequest, res) => {
    const { marginPercent, sellingPrice } = bomPriceSchema.parse(req.body)

    const before = await prisma.bOM.findUnique({
      where: { id: req.params.id },
      include: bomInclude,
    })
    if (!before) throw new AppError('BOM not found', 404, 'NOT_FOUND')

    if (before.status === 'OBSOLETE') {
      throw new AppError(
        'This BOM has been retired, so it is no longer priced. Price the BOM that replaced it.',
        409,
        'BOM_OBSOLETE',
      )
    }

    const cost = Number(before.costPerPiece ?? 0)
    if (cost <= 0) {
      throw new AppError(
        'This BOM has no cost yet. Enter its materials and costing first, then set the price.',
        409,
        'BOM_NO_COST',
      )
    }

    const price = sellingPrice !== undefined ? round(sellingPrice, 2) : priceFromMargin(cost, marginPercent!)
    const margin = sellingPrice !== undefined ? marginFromPrice(cost, price) : round(marginPercent!, 2)

    if (price < cost / 2) {
      throw new AppError(
        `₹${price.toLocaleString('en-IN')} is less than half the cost of ₹${cost.toLocaleString('en-IN')} a piece. Check the price.`,
        400,
        'BOM_PRICE_TOO_LOW',
      )
    }

    const after = await prisma.bOM.update({
      where: { id: before.id },
      data: {
        marginPercent: margin,
        sellingPrice: price,
        pricedById: req.user!.id,
        pricedAt: new Date(),
      },
      include: bomInclude,
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'BOM',
      entityId: after.id,
      before,
      after,
    })

    res.json({
      success: true,
      message: `${bomName(after.style.code, after.color)} is priced at ₹${price.toLocaleString('en-IN')} a piece, a ${margin}% margin.`,
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
        // The costing and the margin come across too, so a new colour starts
        // priced; changing its fabric then moves the price with its margin.
        // Who set the price does not: nobody has priced the copy yet.
        overheadCost: source.overheadCost,
        costPerPiece: source.costPerPiece,
        marginPercent: source.marginPercent,
        sellingPrice: source.sellingPrice,
        ...(source.costLines.length > 0
          ? {
              costLines: {
                create: source.costLines.map((c) => ({
                  kind: c.kind,
                  name: c.name,
                  departmentId: c.departmentId,
                  basis: c.basis,
                  value: c.value,
                  amount: c.amount,
                  sortOrder: c.sortOrder,
                })),
              },
            }
          : {}),
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
    data: forViewer(req, created!),
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
