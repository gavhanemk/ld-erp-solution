import { z } from 'zod'

/**
 * Settings validation.
 *
 * The preference catalogue below is deliberately short. Absolute ERP asks
 * around forty preference questions, most of them belonging to a construction
 * or projects business, and the handful that matter to a garment unit are lost
 * among them. Only preferences the ERP actually reads are listed here, so a
 * switch on this screen always changes something.
 */

// ── Users ────────────────────────────────────────────────────────────────────

const password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(72, 'Passwords longer than 72 characters are truncated by bcrypt')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/[0-9]/, 'Include at least one number')

const blankToNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? null : v), schema.nullable().optional())

export const createUserSchema = z.object({
  name: z.string().min(2, 'Name is required').max(120),
  email: z.string().email('That does not look like an email address').toLowerCase(),
  password,
  roleId: z.string().min(1, 'Pick a role'),
  phone: blankToNull(z.string().max(20)),
  employeeCode: blankToNull(z.string().max(30)),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).default('ACTIVE'),
})

export const updateUserSchema = createUserSchema.omit({ password: true }).partial()

export const resetPasswordSchema = z.object({ password })

export const changeOwnPasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: password,
})

// ── Roles ────────────────────────────────────────────────────────────────────

/** "masters:create" — the same shape requirePermission checks against. */
const permissionKey = z.string().regex(/^[a-z]+:[a-z]+$/, 'Permissions look like "sales:create"')

export const createRoleSchema = z.object({
  name: z.string().min(2, 'Name is required').max(60),
  description: blankToNull(z.string().max(200)),
  permissions: z.array(permissionKey).default([]),
})

export const updateRoleSchema = createRoleSchema.partial()

// ── Number series ────────────────────────────────────────────────────────────

export const createNumberSeriesSchema = z.object({
  docType: z
    .string()
    .min(1, 'Document type is required')
    .max(10)
    .regex(/^[A-Za-z]+$/, 'Letters only')
    .transform((v) => v.toUpperCase()),
  // Real invoice numbers carry punctuation — LD's live series is SI/2026-27.
  // Restricting this to letters and numbers rejected their own numbering.
  prefix: z
    .string()
    .min(1, 'Prefix is required')
    .max(20)
    .regex(/^[A-Za-z0-9/\-.]+$/, 'Letters, numbers, and / - . only'),
  separator: z.string().max(3).default('-'),
  // Either the short token (2627) or the written form (2026-27).
  financialYear: z
    .string()
    .regex(/^(\d{4}|\d{4}-\d{2})$/, 'Financial year looks like 2627 or 2026-27'),
  padding: z.number().int().min(1).max(8).default(4),
  isActive: z.boolean().default(true),
})

/**
 * The document type and financial year identify the series, and the counter is
 * only ever moved by the ERP itself — letting either be edited would produce
 * duplicate document numbers.
 */
export const updateNumberSeriesSchema = createNumberSeriesSchema
  .omit({ docType: true, financialYear: true })
  .partial()

// ── Tax rates ────────────────────────────────────────────────────────────────

export const createTaxRateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(40),
  rate: z.number().min(0, 'Cannot be negative').max(100, 'Cannot exceed 100%'),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
})

export const updateTaxRateSchema = createTaxRateSchema.partial()

// ── Preferences ──────────────────────────────────────────────────────────────

export interface PreferenceDefinition {
  key: string
  label: string
  help: string
  group: string
  type: 'boolean' | 'select' | 'number'
  default: boolean | string | number
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  /** Where in the ERP the setting takes effect, shown beside the control. */
  affects: string
}

export const PREFERENCES: PreferenceDefinition[] = [
  {
    key: 'rowsPerPage',
    label: 'Rows per page',
    help: 'How many records a list shows before it pages.',
    group: 'Lists and screens',
    type: 'select',
    default: '25',
    options: [
      { value: '10', label: '10' },
      { value: '25', label: '25' },
      { value: '50', label: '50' },
      { value: '100', label: '100' },
    ],
    affects: 'Every list screen',
  },
  {
    key: 'dateFormat',
    label: 'Date format',
    help: 'How dates are written throughout the ERP.',
    group: 'Lists and screens',
    type: 'select',
    default: 'DD-MMM-YYYY',
    options: [
      { value: 'DD-MMM-YYYY', label: '24-Aug-2026' },
      { value: 'DD/MM/YYYY', label: '24/08/2026' },
      { value: 'YYYY-MM-DD', label: '2026-08-24' },
    ],
    affects: 'Dates on every screen',
  },
  {
    key: 'lowStockBufferPercent',
    label: 'Warn before stock reaches the reorder level',
    help: 'Flag an item once it comes within this percentage of its reorder level, so there is time to buy.',
    group: 'Stock',
    type: 'number',
    default: 0,
    min: 0,
    max: 100,
    affects: 'Dashboard low-stock alerts',
  },
  {
    key: 'qcInDailyProduction',
    label: 'Quality check on daily production',
    help: 'Turn this off if the line records output without a per-day QC entry.',
    group: 'Production',
    type: 'boolean',
    default: true,
    affects: 'Production menu and QC entries',
  },
  {
    key: 'approvalUrgentAfterDays',
    label: 'Mark an approval urgent after',
    help: 'Days a document may wait for sign-off before the dashboard calls it urgent.',
    group: 'Approvals',
    type: 'number',
    default: 2,
    min: 1,
    max: 30,
    affects: 'Dashboard pending approvals',
  },
]

const byKey = new Map(PREFERENCES.map((p) => [p.key, p]))

/** Rejects unknown keys, and holds each value to the type its definition declares. */
export const preferencesPatchSchema = z
  .record(z.union([z.string(), z.number(), z.boolean()]))
  .superRefine((patch, ctx) => {
    for (const [key, value] of Object.entries(patch)) {
      const def = byKey.get(key)
      if (!def) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Unknown setting '${key}'` })
        continue
      }

      if (def.type === 'boolean' && typeof value !== 'boolean') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Expected true or false' })
      }

      if (def.type === 'number') {
        const n = Number(value)
        if (!Number.isFinite(n)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Expected a number' })
        } else if (def.min !== undefined && n < def.min) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Cannot be below ${def.min}` })
        } else if (def.max !== undefined && n > def.max) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Cannot be above ${def.max}` })
        }
      }

      if (def.type === 'select') {
        const allowed = def.options?.map((o) => o.value) ?? []
        if (!allowed.includes(String(value))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `Choose one of: ${allowed.join(', ')}`,
          })
        }
      }
    }
  })

/** Every preference, defaults first, with saved values laid over the top. */
export function withDefaults(saved: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const def of PREFERENCES) {
    out[def.key] = saved[def.key] ?? def.default
  }
  return out
}
