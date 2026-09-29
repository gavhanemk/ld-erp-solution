import { z } from 'zod'
import { checkRegistration, fromGstin, stateName } from '../lib/gstStates'

// ─────────────────────────────────────────────────────────────
// Shared field helpers
// ─────────────────────────────────────────────────────────────

/**
 * Tax identifiers are always written in capitals, and people copy them out of
 * emails and certificates with stray spaces in them. Refusing a GSTIN because
 * it was typed in lower case, with nothing but "Invalid GSTIN" to explain it,
 * is a fault in the software rather than in what was typed — so they are
 * tidied up before they are checked.
 */
const tidyIdentifier = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.replace(/[\s-]/g, '').toUpperCase() : v),
    schema.optional().nullable(),
  )

/** 15-character GSTIN: 2 state digits, 10-char PAN, entity digit, 'Z', checksum. */
export const gstin = tidyIdentifier(
  z
    .string()
    .length(15, 'A GSTIN is exactly 15 characters — count what you have typed')
    .regex(
      /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
      'That is not a valid GSTIN. It runs: 2 digits for the state, then a 10-character PAN, then a digit, then Z, then one more character.',
    ),
)

export const pan = tidyIdentifier(
  z
    .string()
    .length(10, 'A PAN is exactly 10 characters')
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'A PAN runs: 5 letters, 4 digits, then 1 letter'),
)

const ifsc = tidyIdentifier(
  z
    .string()
    .length(11, 'An IFSC code is exactly 11 characters')
    .regex(
      /^[A-Z]{4}0[A-Z0-9]{6}$/,
      'An IFSC code runs: 4 letters for the bank, then a zero, then 6 more characters',
    ),
)

/** Indian mobile or landline, with optional +91 / 0 prefix and separators. */
const phone = z
  .string()
  .regex(
    /^(\+91[\s-]?)?[0-9][0-9\s-]{7,14}$/,
    'That does not look like a phone number. Ten digits, or +91 in front.',
  )
  .optional()
  .nullable()

/**
 * Zod's own wording for a bad choice is "Invalid enum value. Expected 'FABRIC' |
 * 'THREAD' | ...", which is the software talking to itself. This says what the
 * person actually needs to do.
 */
const pickOne = (what: string) => ({
  errorMap: () => ({ message: `Choose ${what} from the list` }),
})

const email = z
  .string()
  .email('That does not look like an email address')
  .optional()
  .nullable()
const pincode = z
  .string()
  .regex(/^[1-9][0-9]{5}$/, 'An Indian PIN code is 6 digits and does not start with 0')
  .optional()
  .nullable()

/**
 * Master codes are used in documents and URLs, so they are kept tight — but a
 * trailing space from a paste should not be treated as a mistake by the person
 * typing.
 */
const code = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
  z
    .string()
    .min(1, 'Code is required')
    .max(30)
    .regex(
      /^[A-Za-z0-9._/-]+$/,
      'A code can hold letters, numbers, dot, dash and slash — no spaces',
    ),
)

/**
 * Two-digit GST state code. This, not the state name, decides whether a sale is
 * taxed CGST+SGST or IGST, so it cannot be free text. Derived from the GSTIN
 * when one is given.
 */
export const stateCode = z
  .string()
  .regex(/^[0-9]{2}$/, 'A state code is the two digits your GSTIN starts with')
  .optional()
  .nullable()

const name = z.string().min(1, 'Name is required').max(200)
const optionalText = z.string().max(500).optional().nullable()

/** Money and quantity arrive as JSON numbers or strings; Prisma Decimal takes both. */
const decimal = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)])

/**
 * A quantity that has to be there: more than nought. A BOM line of -2 metres
 * saved at ₹-236 and was approved, and a line of 0 costs nothing and draws
 * nothing, so neither is a component.
 */
const positiveDecimal = z.union([
  z.number().positive('A quantity has to be more than nought'),
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'A quantity has to be a number more than nought')
    .refine((v) => Number(v) > 0, 'A quantity has to be more than nought'),
])
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
], pickOne('an item type'))
const CustomerTypeEnum = z.enum(['DOMESTIC', 'EXPORT', 'JOB_WORK', 'VHAGAR_DEALER'], pickOne('a customer type'))
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
], pickOne('what this supplier provides'))
const BrandTypeEnum = z.enum(['LD_COTTON_MILLS', 'VHAGAR', 'CUSTOM'], pickOne('a brand'))

/** Every master can be deactivated; only DELETE flips it implicitly. */
const isActive = z.boolean().optional()

// ─────────────────────────────────────────────────────────────
// Customer
// ─────────────────────────────────────────────────────────────

const customerFields = z.object({
  // Left out on a new record: the server makes one up. Still validated when
  // somebody does supply one, so an imported code cannot be malformed.
  code: code.optional(),
  name,
  type: CustomerTypeEnum,
  gstin,
  pan,
  phone,
  email,
  billingAddress: optionalText,
  billingCity: z.string().max(100).optional().nullable(),
  billingState: z.string().max(100).optional().nullable(),
  billingStateCode: stateCode,
  billingPincode: pincode,
  shippingAddress: optionalText,
  shippingCity: z.string().max(100).optional().nullable(),
  shippingState: z.string().max(100).optional().nullable(),
  shippingStateCode: stateCode,
  shippingPincode: pincode,
  shippingGstin: gstin,
  isGroupCompany: z.boolean().optional(),
  brokerId: z.string().optional().nullable(),
  brokeragePercent: z.number().min(0).max(100).optional().nullable(),
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

/*
 * A customer's GSTIN, state code and PAN have to agree, or every invoice to
 * them carries the wrong tax: GSTIN 27… with state code 24 used to save, and
 * was taxed as Gujarat. What the GSTIN already says is filled in when left
 * empty, and the state's name always comes from its code.
 */
type CustomerIn = z.infer<typeof customerFields>
const checkCustomer = (v: Partial<CustomerIn>, ctx: z.RefinementCtx) => {
  checkRegistration(
    { gstin: v.gstin, stateCode: v.billingStateCode, pan: v.pan },
    { stateCode: 'billingStateCode', pan: 'pan' },
    ctx,
  )
  checkRegistration(
    { gstin: v.shippingGstin, stateCode: v.shippingStateCode },
    { stateCode: 'shippingStateCode' },
    ctx,
  )
}
const fillCustomer = <T extends Partial<CustomerIn>>(v: T): T => {
  const billing = fromGstin(v.gstin)
  const shipping = fromGstin(v.shippingGstin)
  const out = { ...v }
  if (billing && !out.billingStateCode) out.billingStateCode = billing.stateCode
  if (billing && !out.pan) out.pan = billing.pan
  if (shipping && !out.shippingStateCode) out.shippingStateCode = shipping.stateCode
  if (out.billingStateCode) out.billingState = stateName(out.billingStateCode) ?? out.billingState
  if (out.shippingStateCode) out.shippingState = stateName(out.shippingStateCode) ?? out.shippingState
  return out
}
export const createCustomerSchema = customerFields.superRefine(checkCustomer).transform(fillCustomer)
export const updateCustomerSchema = customerFields.partial().superRefine(checkCustomer).transform(fillCustomer)

// ─────────────────────────────────────────────────────────────
// Supplier
// ─────────────────────────────────────────────────────────────

const supplierFields = z.object({
  // Left out on a new record: the server makes one up. Still validated when
  // somebody does supply one, so an imported code cannot be malformed.
  code: code.optional(),
  name,
  category: SupplierCategoryEnum,
  gstin,
  pan,
  phone,
  email,
  address: optionalText,
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  stateCode,
  pincode,
  isMsme: z.boolean().optional(),
  msmeNumber: z.string().max(30).optional().nullable(),
  isGroupCompany: z.boolean().optional(),
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

/** A supplier's GSTIN, state code and PAN agree, as a customer's must. */
type SupplierIn = z.infer<typeof supplierFields>
const checkSupplier = (v: Partial<SupplierIn>, ctx: z.RefinementCtx) =>
  checkRegistration({ gstin: v.gstin, stateCode: v.stateCode, pan: v.pan }, { stateCode: 'stateCode', pan: 'pan' }, ctx)
const fillSupplier = <T extends Partial<SupplierIn>>(v: T): T => {
  const reg = fromGstin(v.gstin)
  const out = { ...v }
  if (reg && !out.stateCode) out.stateCode = reg.stateCode
  if (reg && !out.pan) out.pan = reg.pan
  if (out.stateCode) out.state = stateName(out.stateCode) ?? out.state
  return out
}
export const createSupplierSchema = supplierFields.superRefine(checkSupplier).transform(fillSupplier)
export const updateSupplierSchema = supplierFields.partial().superRefine(checkSupplier).transform(fillSupplier)

// ─────────────────────────────────────────────────────────────
// Item
// ─────────────────────────────────────────────────────────────

export const createItemSchema = z
  .object({
    // Left out on a new record: the server makes one up. Still validated when
    // somebody does supply one, so an imported code cannot be malformed.
    code: code.optional(),
    name,
    description: optionalText,
    type: ItemTypeEnum,
    categoryId: z.string().min(1, 'Choose a category from the list'),
    uomId: z.string().min(1, 'Choose a unit — pieces, metres, kilograms and so on'),
    // The department that normally uses it. Optional; null clears it.
    departmentId: z.string().min(1).optional().nullable(),
    hsnCode: z
      .string()
      .regex(/^[0-9]{4,8}$/, 'An HSN code is 4 to 8 digits, nothing else')
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
  // The size run is a named master now, not a typed-in list. Free text let
  // "XL" and "xl" both exist and the quantities quietly stopped reconciling.
  sizeGroupId: z.string().min(1).optional().nullable(),
  // "White" and "white" were both accepted, and a BOM made for one could not
  // be found under the other.
  colors: z
    .array(z.string().trim().min(1).max(50))
    .default([])
    .refine(
      (list) => new Set(list.map((c) => c.toLowerCase())).size === list.length,
      'A colour is listed twice. Each colour once, however it is capitalised.',
    ),
  techPackUrl: z.string().url().optional().nullable(),
  imageUrl: z.string().url().optional().nullable(),
  isActive,
})
export const updateStyleSchema = createStyleSchema.partial()

// ─────────────────────────────────────────────────────────────
// BOM — header plus its component lines
// ─────────────────────────────────────────────────────────────

/**
 * A size that draws more or less cloth than the base size. Only the sizes that
 * actually differ are sent — everything else falls back to the line's own
 * quantity, which is what lets a style with no size run carry on unchanged.
 */
export const bomLineSizeSchema = z.object({
  sizeId: z.string().min(1, 'Pick a size'),
  qtyPerUnit: positiveDecimal,
})

export const bomLineSchema = z.object({
  componentItemId: z.string().min(1, 'Component item is required'),
  /**
   * Which part of the garment this goes into. The same self fabric appears
   * twice on a shirt BOM at two different wastages, and without a label the
   * second line looks like somebody added it by mistake.
   */
  component: z.string().max(60).optional().nullable(),
  /** The department that draws this from the store — Cutting, Stitching, Packing. */
  departmentId: z.string().optional().nullable(),
  qtyPerUnit: positiveDecimal,
  wastagePercent: z.number().min(0).max(100).optional(),
  unitCost: nonNegativeDecimal,
  notes: optionalText,
  sortOrder: z.number().int().min(0).optional(),
  sizes: z
    .array(bomLineSizeSchema)
    .optional()
    .refine((rows) => !rows || new Set(rows.map((r) => r.sizeId)).size === rows.length, {
      message: 'A size can only be given once on a component',
    }),
})

/**
 * One labour or overhead row on a BOM's costing. Labour is always rupees for
 * one piece — that is how a stitching rate is quoted. An overhead can be either
 * rupees or a percentage of material and labour together.
 */
export const bomCostLineSchema = z
  .object({
    kind: z.enum(['LABOUR', 'OVERHEAD']),
    name: z.string().trim().min(1, 'Name the cost, such as Stitching or Transport').max(60),
    departmentId: z.string().optional().nullable(),
    basis: z.enum(['PER_PIECE', 'PERCENT']).default('PER_PIECE'),
    value: z.number().min(0, 'A cost cannot be negative'),
  })
  .superRefine((row, ctx) => {
    if (row.kind === 'LABOUR' && row.basis !== 'PER_PIECE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['basis'],
        message: 'Labour is typed in rupees for one piece',
      })
    }
    if (row.basis === 'PERCENT' && row.value > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'An overhead percentage cannot be more than 100',
      })
    }
  })

/**
 * Setting the price takes one of the two: a margin, which works the price out,
 * or a price typed straight in, which works the margin back from it. Margin is
 * a share of the selling price, so 100% would mean a cost of nothing.
 */
export const bomPriceSchema = z
  .object({
    marginPercent: z
      .number()
      .min(0, 'A margin cannot be negative. To sell below cost, type the price instead.')
      .lt(100, 'A margin must be under 100%')
      .optional(),
    sellingPrice: z.number().positive('Type a price above zero').optional(),
  })
  .refine((v) => (v.marginPercent === undefined) !== (v.sellingPrice === undefined), {
    message: 'Give either a margin or a selling price',
  })

export const createBomSchema = z.object({
  styleId: z.string().min(1, 'Style is required'),
  /**
   * One BOM per colour. Whether it is required depends on the style — one with
   * colours listed needs it — so that check lives in the route, not here.
   */
  color: z.string().trim().max(60).optional().nullable(),
  version: z.string().max(20).optional(),
  /** The routing that supplies the labour half of the cost. Optional. */
  routingId: z.string().optional().nullable(),
  /** The size the quantities on the lines are measured against. */
  baseSizeId: z.string().optional().nullable(),
  notes: optionalText,
  lines: z.array(bomLineSchema).min(1, 'A BOM needs at least one component'),
  /** Labour and overhead. Only someone who may approve masters can send these. */
  costLines: z.array(bomCostLineSchema).max(50).optional(),
  isActive,
})

export const updateBomSchema = z.object({
  version: z.string().max(20).optional(),
  routingId: z.string().optional().nullable(),
  baseSizeId: z.string().optional().nullable(),
  notes: optionalText,
  lines: z.array(bomLineSchema).min(1).optional(),
  /** Left out, the BOM keeps the rows it has; sent, they replace them. */
  costLines: z.array(bomCostLineSchema).max(50).optional(),
  isActive,
})

/**
 * Approving freezes a BOM, so a new version has to start life as a copy. If it
 * did not, the only way to change an approved costing would be to edit it in
 * place, which is exactly what the freeze exists to stop.
 */
export const copyBomSchema = z
  .object({
    version: z.string().trim().min(1, 'Give the copy a version, such as 1.1').max(20).optional(),
    /**
     * Copying to another colour is the usual way a new colourway's BOM is made:
     * the buttons, labels and packing carry over, and only the fabric changes.
     */
    color: z.string().trim().max(60).optional().nullable(),
  })
  .refine((v) => v.version !== undefined || v.color !== undefined, {
    message: 'Give the copy a new version, a different colour, or both',
  })

// ─────────────────────────────────────────────────────────────
// Warehouse / Department / Operation / Machine / UOM / Category
// ─────────────────────────────────────────────────────────────

export const createWarehouseSchema = z.object({
  companyId: z.string().min(1, 'Company is required'),
  // Left out on a new record: the server makes one up. Still validated when
  // somebody does supply one, so an imported code cannot be malformed.
  code: code.optional(),
  name,
  address: optionalText,
  isActive,
})
export const updateWarehouseSchema = createWarehouseSchema.partial()

/**
 * The accounts money leaves from — what a supplier payment calls "Paid
 * through". The mill's own vouchers name one on every payment that is not
 * cash, so the list has to be somewhere a person can add to.
 *
 * IFSC is eleven characters with a fixed shape: four letters, a zero, then
 * six of either. Wrong and the money does not move, so it is worth refusing
 * at the form rather than at the bank.
 */
export const createBankAccountSchema = z.object({
  accountName: name,
  bankName: z.string().min(1, 'Which bank it is with').max(120),
  accountNumber: z.string().min(1, 'The account number is required').max(30),
  ifscCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'An IFSC code looks like HDFC0001234'),
  branch: optionalText,
  accountType: z.enum(['CURRENT', 'SAVINGS', 'CC', 'OD']).optional(),
  openingBalance: z.coerce.number().optional(),
  isActive,
})
export const updateBankAccountSchema = createBankAccountSchema.partial()

export const createDepartmentSchema = z.object({
  companyId: z.string().min(1, 'Company is required'),
  // Made from the name when left out: "Printing QC" → PRIQC.
  code: code.optional(),
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
  /** What an outside unit is paid per piece for this operation. */
  jobWorkRate: nonNegativeDecimal,
  /** Position in the default factory sequence, so pickers read in floor order. */
  sortOrder: z.number().int().min(0).max(999).optional(),
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
  // The department a new item in this category starts with. Null clears it.
  departmentId: z.string().min(1).optional().nullable(),
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
  stateCode,
  pincode,
  gstin,
  pan,
  /** Needed on TDS challans and to issue Form 16A. */
  tan: z
    .string()
    .regex(/^[A-Z]{4}[0-9]{5}[A-Z]$/, 'Invalid TAN')
    .optional()
    .nullable(),
  msmeNumber: z.string().max(30).optional().nullable(),
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
  booksStartDate: z.coerce.date().optional().nullable(),
})

// ─────────────────────────────────────────────────────────────
// Shop floor and commercial masters
// ─────────────────────────────────────────────────────────────

export const createSizeGroupSchema = z.object({
  name,
  gender: z.enum(['MALE', 'FEMALE', 'UNISEX']).optional().nullable(),
  isActive,
})
export const updateSizeGroupSchema = createSizeGroupSchema.partial()

export const createSizeSchema = z.object({
  sizeGroupId: z.string().min(1, 'Pick a size run'),
  code: z.string().min(1, 'Code is required').max(20),
  label: z.string().min(1, 'Label is required').max(40),
  sequence: z.number().int().min(0).max(999).default(0),
})
export const updateSizeSchema = createSizeSchema.partial()

export const createWorkstationSchema = z
  .object({
    // Left out on a new record: the server makes one up. Still validated when
    // somebody does supply one, so an imported code cannot be malformed.
    code: code.optional(),
    name,
    departmentId: z.string().min(1, 'Pick the process this belongs to'),
    type: z.enum(['IN_HOUSE', 'JOB_WORK']).default('IN_HOUSE'),
    supplierId: z.string().optional().nullable(),
    capacityPerDay: z.number().int().min(0).max(1000000).optional().nullable(),
    address: optionalText,
    contactPerson: z.string().max(120).optional().nullable(),
    phone,
    isActive,
  })
  // An outside unit that is not linked to a supplier can never be paid, which
  // is the whole reason for recording it.
  .refine((v) => v.type !== 'JOB_WORK' || Boolean(v.supplierId), {
    message: 'A job-work unit must be linked to the supplier you pay for it',
    path: ['supplierId'],
  })

export const updateWorkstationSchema = z.object({
  code: code.optional(),
  name: name.optional(),
  departmentId: z.string().min(1).optional(),
  type: z.enum(['IN_HOUSE', 'JOB_WORK']).optional(),
  supplierId: z.string().optional().nullable(),
  capacityPerDay: z.number().int().min(0).max(1000000).optional().nullable(),
  address: optionalText,
  contactPerson: z.string().max(120).optional().nullable(),
  phone,
  isActive,
})

const brokerFields = z.object({
  // Left out on a new record: the server makes one up. Still validated when
  // somebody does supply one, so an imported code cannot be malformed.
  code: code.optional(),
  name,
  phone,
  email,
  gstin,
  pan,
  address: optionalText,
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  stateCode,
  brokeragePercent: z.number().min(0).max(100).default(0),
  tdsSection: z.string().max(10).optional().nullable(),
  tdsRate: z.number().min(0).max(100).optional().nullable(),
  notes: optionalText,
  isActive,
})

/*
 * An agent's GSTIN, state code and PAN agree, as a customer's and a
 * supplier's must: the commission bill they raise is taxed by that state,
 * and TDS is deducted against that PAN.
 */
type BrokerIn = z.infer<typeof brokerFields>
const checkBroker = (v: Partial<BrokerIn>, ctx: z.RefinementCtx) =>
  checkRegistration({ gstin: v.gstin, stateCode: v.stateCode, pan: v.pan }, { stateCode: 'stateCode', pan: 'pan' }, ctx)
const fillBroker = <T extends Partial<BrokerIn>>(v: T): T => {
  const reg = fromGstin(v.gstin)
  const out = { ...v }
  if (reg && !out.stateCode) out.stateCode = reg.stateCode
  if (reg && !out.pan) out.pan = reg.pan
  if (out.stateCode) out.state = stateName(out.stateCode) ?? out.state
  return out
}
export const createBrokerSchema = brokerFields.superRefine(checkBroker).transform(fillBroker)
export const updateBrokerSchema = brokerFields.partial().superRefine(checkBroker).transform(fillBroker)

export const createChargeTypeSchema = z.object({
  name,
  /*
   * The GST charged on this charge — 5% on dyeing, 18% on freight.
   *
   * It is not how big the charge is. The amount is typed in on each order,
   * the way the mill's old system worked: only the tax is worked out for you.
   */
  defaultGstRate: z.number().min(0).max(100).default(0),
  /*
   * What this charge usually comes to as a share of the order.
   *
   * A different thing entirely from the rate above, and the two are easy to
   * confuse because they are both percentages and are often the same number:
   * this one is how big the charge is, that one is the tax on it.
   *
   * Nothing applies it on its own. A charge is still typed in on every order,
   * because what a transporter asks for is agreed on a call and not derived
   * from anything. This is only the figure the percentage helper on the
   * purchase order opens at, so the usual rate takes one press instead of a
   * calculator. 0 means nobody has set one, and the helper opens on the GST
   * rate instead — which is at least the number printed on the row.
   */
  percentOfValue: z.number().min(0).max(100).default(0),
  applyOnSale: z.boolean().default(true),
  applyOnPurchase: z.boolean().default(false),
  isActive,
})
export const updateChargeTypeSchema = createChargeTypeSchema.partial()

// ─────────────────────────────────────────────────────────────
// Routing — a style's ordered path through the factory
// ─────────────────────────────────────────────────────────────

export const routingStepSchema = z.object({
  sequence: z.number().int().min(1).max(200),
  operationId: z.string().min(1, 'Pick an operation'),
  departmentId: z.string().min(1, 'Pick a department'),
  workstationId: z.string().optional().nullable(),
  smv: z.number().min(0).max(999).optional().nullable(),
  ratePerPiece: z.number().min(0).max(100000).optional().nullable(),
  isQcStep: z.boolean().default(false),
})

export const createRoutingSchema = z.object({
  code,
  name,
  styleId: z.string().min(1, 'Pick a style'),
  notes: optionalText,
  isActive,
  steps: z
    .array(routingStepSchema)
    .min(1, 'A routing needs at least one step')
    // Two steps at the same position have no defined order, and the database
    // rejects it anyway — catching it here gives a readable message.
    .refine((steps) => new Set(steps.map((s) => s.sequence)).size === steps.length, {
      message: 'Two steps cannot share the same position',
    }),
})

export const updateRoutingSchema = createRoutingSchema.partial().extend({
  isLocked: z.boolean().optional(),
})
