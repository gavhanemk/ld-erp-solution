import { z } from 'zod'

// ─────────────────────────────────────────────────────────────
// Shared field helpers
// ─────────────────────────────────────────────────────────────

/** 15-character GSTIN: 2 state digits, 10-char PAN, entity digit, 'Z', checksum. */
const gstin = z
  .string()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Invalid GSTIN')
  .optional()
  .nullable()

const pan = z
  .string()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN')
  .optional()
  .nullable()

const ifsc = z
  .string()
  .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code')
  .optional()
  .nullable()

/** Indian mobile or landline, with optional +91 / 0 prefix and separators. */
const phone = z
  .string()
  .regex(/^(\+91[\s-]?)?[0-9][0-9\s-]{7,14}$/, 'Invalid phone number')
  .optional()
  .nullable()

const email = z.string().email('Invalid email address').optional().nullable()
const pincode = z
  .string()
  .regex(/^[1-9][0-9]{5}$/, 'Invalid PIN code')
  .optional()
  .nullable()

/** Master codes are used in documents and URLs, so keep them tight. */
const code = z
  .string()
  .min(1, 'Code is required')
  .max(30)
  .regex(/^[A-Za-z0-9._/-]+$/, 'Code may only contain letters, numbers, dot, dash, slash')
  .transform((v) => v.toUpperCase())

const name = z.string().min(1, 'Name is required').max(200)
const optionalText = z.string().max(500).optional().nullable()

/** Money and quantity arrive as JSON numbers or strings; Prisma Decimal takes both. */
const decimal = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)])
const nonNegativeDecimal = z
  .union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?$/)])
  .optional()
  .nullable()

const ItemTypeEnum = z.enum([
  'RAW_MATERIAL',
  'SEMI_FINISHED',
  'FINISHED_GOOD',
  'CONSUMABLE',
  'PACKING_MATERIAL',
  'TRIM',
])
const CustomerTypeEnum = z.enum(['DOMESTIC', 'EXPORT', 'JOB_WORK', 'VHAGAR_DEALER'])
const SupplierCategoryEnum = z.enum([
  'FABRIC',
  'THREAD',
  'BUTTON',
  'LINING',
  'LABEL',
  'PACKAGING',
  'TRIM',
  'TRANSPORT',
  'SERVICE',
  'OTHER',
])
const BrandTypeEnum = z.enum(['LD_COTTON_MILLS', 'VHAGAR', 'CUSTOM'])

/** Every master can be deactivated; only DELETE flips it implicitly. */
const isActive = z.boolean().optional()

// ─────────────────────────────────────────────────────────────
// Customer
// ─────────────────────────────────────────────────────────────

export const createCustomerSchema = z.object({
  code,
  name,
  type: CustomerTypeEnum,
  gstin,
  pan,
  phone,
  email,
  billingAddress: optionalText,
  billingCity: z.string().max(100).optional().nullable(),
  billingState: z.string().max(100).optional().nullable(),
  billingPincode: pincode,
  shippingAddress: optionalText,
  creditLimit: nonNegativeDecimal,
  creditDays: z.number().int().min(0).max(365).optional(),
  paymentTerms: optionalText,
  bankName: z.string().max(150).optional().nullable(),
  bankAccount: z.string().max(30).optional().nullable(),
  bankIFSC: ifsc,
  isBlacklisted: z.boolean().optional(),
  notes: optionalText,
  isActive,
})
export const updateCustomerSchema = createCustomerSchema.partial()

// ─────────────────────────────────────────────────────────────
// Supplier
// ─────────────────────────────────────────────────────────────

export const createSupplierSchema = z.object({
  code,
  name,
  category: SupplierCategoryEnum,
  gstin,
  pan,
  phone,
  email,
  address: optionalText,
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  pincode,
  creditDays: z.number().int().min(0).max(365).optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  paymentTerms: optionalText,
  bankName: z.string().max(150).optional().nullable(),
  bankAccount: z.string().max(30).optional().nullable(),
  bankIFSC: ifsc,
  rating: z.number().int().min(1).max(5).optional().nullable(),
  isPreferred: z.boolean().optional(),
  notes: optionalText,
  isActive,
})
export const updateSupplierSchema = createSupplierSchema.partial()

// ─────────────────────────────────────────────────────────────
// Item
// ─────────────────────────────────────────────────────────────

export const createItemSchema = z
  .object({
    code,
    name,
    description: optionalText,
    type: ItemTypeEnum,
    categoryId: z.string().min(1, 'Category is required'),
    uomId: z.string().min(1, 'Unit of measure is required'),
    hsnCode: z
      .string()
      .regex(/^[0-9]{4,8}$/, 'HSN code must be 4 to 8 digits')
      .optional()
      .nullable(),
    reorderLevel: nonNegativeDecimal,
    minStock: nonNegativeDecimal,
    maxStock: nonNegativeDecimal,
    standardRate: nonNegativeDecimal,
    imageUrl: z.string().url().optional().nullable(),
    isActive,
  })
  .refine(
    (v) =>
      v.minStock == null || v.maxStock == null || Number(v.minStock) <= Number(v.maxStock),
    { message: 'Minimum stock cannot exceed maximum stock', path: ['minStock'] },
  )

export const updateItemSchema = createItemSchema.innerType().partial()

// ─────────────────────────────────────────────────────────────
// Style
// ─────────────────────────────────────────────────────────────

export const createStyleSchema = z.object({
  code,
  name,
  season: z.string().max(50).optional().nullable(),
  brandType: BrandTypeEnum,
  category: z.string().max(100).optional().nullable(),
  collarType: z.string().max(100).optional().nullable(),
  sleeveType: z.string().max(100).optional().nullable(),
  fit: z.string().max(100).optional().nullable(),
  fabricType: z.string().max(100).optional().nullable(),
  gsm: z.number().int().min(1).max(2000).optional().nullable(),
  sizeSet: z.array(z.string().min(1).max(20)).default([]),
  colors: z.array(z.string().min(1).max(50)).default([]),
  techPackUrl: z.string().url().optional().nullable(),
  imageUrl: z.string().url().optional().nullable(),
  isActive,
})
export const updateStyleSchema = createStyleSchema.partial()

// ─────────────────────────────────────────────────────────────
// BOM — header plus its component lines
// ─────────────────────────────────────────────────────────────

export const bomLineSchema = z.object({
  componentItemId: z.string().min(1, 'Component item is required'),
  qtyPerUnit: decimal,
  wastagePercent: z.number().min(0).max(100).optional(),
  unitCost: nonNegativeDecimal,
  notes: optionalText,
  sortOrder: z.number().int().min(0).optional(),
})

export const createBomSchema = z.object({
  styleId: z.string().min(1, 'Style is required'),
  version: z.string().max(20).optional(),
  notes: optionalText,
  lines: z.array(bomLineSchema).min(1, 'A BOM needs at least one component'),
  isActive,
})

export const updateBomSchema = z.object({
  version: z.string().max(20).optional(),
  notes: optionalText,
  lines: z.array(bomLineSchema).min(1).optional(),
  isActive,
})

// ─────────────────────────────────────────────────────────────
// Warehouse / Department / Operation / Machine / UOM / Category
// ─────────────────────────────────────────────────────────────

export const createWarehouseSchema = z.object({
  companyId: z.string().min(1, 'Company is required'),
  code,
  name,
  address: optionalText,
  isActive,
})
export const updateWarehouseSchema = createWarehouseSchema.partial()

export const createDepartmentSchema = z.object({
  companyId: z.string().min(1, 'Company is required'),
  code,
  name,
  isActive,
})
export const updateDepartmentSchema = createDepartmentSchema.partial()

export const createOperationSchema = z.object({
  departmentId: z.string().min(1, 'Department is required'),
  code,
  name,
  /** Standard Minute Value — minutes one unit of this operation takes. */
  smv: nonNegativeDecimal,
  isActive,
})
export const updateOperationSchema = createOperationSchema.partial()

export const createMachineSchema = z.object({
  machineNo: code,
  name,
  type: z.string().min(1, 'Machine type is required').max(50),
  brand: z.string().max(100).optional().nullable(),
  model: z.string().max(100).optional().nullable(),
  departmentId: z.string().min(1, 'Department is required'),
  purchaseDate: z.coerce.date().optional().nullable(),
  warrantyExpiry: z.coerce.date().optional().nullable(),
  amcStart: z.coerce.date().optional().nullable(),
  amcEnd: z.coerce.date().optional().nullable(),
  status: z.enum(['OPERATIONAL', 'IDLE', 'UNDER_MAINTENANCE', 'BREAKDOWN', 'RETIRED']).optional(),
  isActive,
})
export const updateMachineSchema = createMachineSchema.partial()

export const createUomSchema = z.object({
  name,
  symbol: z.string().min(1, 'Symbol is required').max(20),
  isActive,
})
export const updateUomSchema = createUomSchema.partial()

export const createItemCategorySchema = z.object({
  name,
  parentId: z.string().optional().nullable(),
  isActive,
})
export const updateItemCategorySchema = createItemCategorySchema.partial()

export const createBrandSchema = z.object({
  companyId: z.string().min(1, 'Company is required'),
  name,
  type: BrandTypeEnum,
  description: optionalText,
  logoUrl: z.string().url().optional().nullable(),
  isActive,
})
export const updateBrandSchema = createBrandSchema.partial()

export const updateCompanySchema = z.object({
  name: name.optional(),
  legalName: z.string().max(200).optional().nullable(),
  address: optionalText,
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  pincode,
  gstin,
  pan,
  phone,
  email,
  website: z.string().url().optional().nullable(),
  logoUrl: z.string().url().optional().nullable(),
  currentFY: z
    .string()
    .regex(/^\d{4}$/, 'Financial year token looks like 2425')
    .optional()
    .nullable(),
  fyStartMonth: z.number().int().min(1).max(12).optional(),
})
