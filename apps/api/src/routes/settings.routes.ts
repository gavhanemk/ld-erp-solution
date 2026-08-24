import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { updateCompanySchema } from '../schemas/master.schemas'
import {
  PREFERENCES,
  changeOwnPasswordSchema,
  createNumberSeriesSchema,
  createRoleSchema,
  createTaxRateSchema,
  createUserSchema,
  preferencesPatchSchema,
  resetPasswordSchema,
  updateNumberSeriesSchema,
  updateRoleSchema,
  updateTaxRateSchema,
  updateUserSchema,
  withDefaults,
} from '../schemas/settings.schemas'
import { getPreferences, invalidatePreferences } from '../lib/preferences'
import { AI_MODELS, getAiConfig, maskKey, saveAiConfig } from '../lib/aiConfig'

const router = Router()

/** Company profile, number series, tax rates and preferences. */
const SETTINGS = 'settings'
/** Users, roles and the activity trail — a narrower group than SETTINGS. */
const ADMIN = 'admin'

/** The role that can never be locked out; mirrors SUPER_ROLE in the auth middleware. */
const SUPER_ROLE = 'Admin'

const BCRYPT_ROUNDS = 10

/** There is exactly one company row per install, so nothing should ask which. */
async function companyId(): Promise<string> {
  const company = await prisma.company.findFirst({ select: { id: true } })
  if (!company) {
    throw new AppError('Company profile is not set up yet. Seed the database first.', 409, 'NO_COMPANY')
  }
  return company.id
}

// ═══════════════════════════════════════════
// COMPANY
// ═══════════════════════════════════════════

router.get('/company', requirePermission(SETTINGS, 'view'), async (_req, res) => {
  const company = await prisma.company.findFirst()
  if (!company) throw new AppError('Company profile not set up yet', 404, 'NOT_FOUND')
  res.json({ success: true, data: company })
})

router.patch('/company', requirePermission(SETTINGS, 'edit'), async (req: AuthRequest, res) => {
  const data = updateCompanySchema.parse(req.body)

  const before = await prisma.company.findFirst()
  if (!before) throw new AppError('Company profile not set up yet', 404, 'NOT_FOUND')

  const after = await prisma.company.update({ where: { id: before.id }, data })

  await writeAuditLog(req, {
    module: SETTINGS,
    action: 'UPDATE',
    entityType: 'Company',
    entityId: after.id,
    before,
    after,
  })

  res.json({ success: true, data: after })
})

// ═══════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════

/** Everything about a user except the password hash, which never leaves the server. */
const userView = {
  id: true,
  name: true,
  email: true,
  phone: true,
  employeeCode: true,
  status: true,
  roleId: true,
  avatarUrl: true,
  lastLoginAt: true,
  createdAt: true,
  role: { select: { id: true, name: true } },
} as const

router.get('/users', requirePermission(ADMIN, 'view'), async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

  const users = await prisma.user.findMany({
    where: q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { employeeCode: { contains: q, mode: 'insensitive' } },
          ],
        }
      : undefined,
    select: userView,
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
  })

  res.json({ success: true, data: users, pagination: { page: 1, limit: users.length, total: users.length, pages: 1 } })
})

router.post('/users', requirePermission(ADMIN, 'create'), async (req: AuthRequest, res) => {
  const data = createUserSchema.parse(req.body)

  const role = await prisma.role.findUnique({ where: { id: data.roleId } })
  if (!role) throw new AppError('That role no longer exists', 400, 'INVALID_ROLE')

  const existing = await prisma.user.findUnique({ where: { email: data.email } })
  if (existing) throw new AppError('Someone already signs in with that email address', 409, 'DUPLICATE_EMAIL')

  const { password, ...rest } = data
  const user = await prisma.user.create({
    data: { ...rest, passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) },
    select: userView,
  })

  await writeAuditLog(req, {
    module: ADMIN,
    action: 'CREATE',
    entityType: 'User',
    entityId: user.id,
    after: user,
  })

  res.status(201).json({ success: true, data: user })
})

router.patch('/users/:id', requirePermission(ADMIN, 'edit'), async (req: AuthRequest, res) => {
  const data = updateUserSchema.parse(req.body)

  const before = await prisma.user.findUnique({ where: { id: req.params.id }, select: userView })
  if (!before) throw new AppError('User not found', 404, 'NOT_FOUND')

  const isSelf = req.user?.id === before.id

  // Editing your own role or status is how an administrator accidentally locks
  // themselves out, and it would also leave the token in their browser
  // claiming permissions the database no longer grants.
  if (isSelf && data.roleId && data.roleId !== before.roleId) {
    throw new AppError('You cannot change your own role. Ask another administrator.', 400, 'SELF_ROLE_CHANGE')
  }
  if (isSelf && data.status && data.status !== before.status) {
    throw new AppError('You cannot change your own status.', 400, 'SELF_STATUS_CHANGE')
  }

  if (data.roleId && data.roleId !== before.roleId) {
    const role = await prisma.role.findUnique({ where: { id: data.roleId } })
    if (!role) throw new AppError('That role no longer exists', 400, 'INVALID_ROLE')
  }

  // Losing every administrator means nobody can ever create one again.
  const losingAdmin =
    before.role.name === SUPER_ROLE &&
    ((data.roleId && data.roleId !== before.roleId) || (data.status && data.status !== 'ACTIVE'))

  if (losingAdmin) await assertAnotherAdminRemains(before.id)

  if (data.email && data.email !== before.email) {
    const clash = await prisma.user.findUnique({ where: { email: data.email } })
    if (clash) throw new AppError('Someone already signs in with that email address', 409, 'DUPLICATE_EMAIL')
  }

  const after = await prisma.user.update({
    where: { id: before.id },
    data,
    select: userView,
  })

  await writeAuditLog(req, {
    module: ADMIN,
    action: 'UPDATE',
    entityType: 'User',
    entityId: after.id,
    before,
    after,
  })

  res.json({ success: true, data: after })
})

router.post('/users/:id/reset-password', requirePermission(ADMIN, 'edit'), async (req: AuthRequest, res) => {
  const { password } = resetPasswordSchema.parse(req.body)

  const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, name: true } })
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND')

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) },
  })

  // The password itself must never reach the audit trail, so only the fact of
  // the reset is recorded.
  await writeAuditLog(req, {
    module: ADMIN,
    action: 'UPDATE',
    entityType: 'User',
    entityId: user.id,
    after: { passwordReset: true },
  })

  res.json({ success: true, message: `Password reset for ${user.name}.` })
})

/**
 * Users are referenced by every document they ever touched, so they are
 * deactivated rather than deleted. An inactive user is refused at login.
 */
router.delete('/users/:id', requirePermission(ADMIN, 'delete'), async (req: AuthRequest, res) => {
  const before = await prisma.user.findUnique({ where: { id: req.params.id }, select: userView })
  if (!before) throw new AppError('User not found', 404, 'NOT_FOUND')

  if (req.user?.id === before.id) {
    throw new AppError('You cannot deactivate your own account.', 400, 'SELF_DEACTIVATE')
  }
  if (before.role.name === SUPER_ROLE) await assertAnotherAdminRemains(before.id)

  const after = await prisma.user.update({
    where: { id: before.id },
    data: { status: 'INACTIVE' },
    select: userView,
  })

  await writeAuditLog(req, {
    module: ADMIN,
    action: 'DELETE',
    entityType: 'User',
    entityId: after.id,
    before,
    after,
  })

  res.json({ success: true, message: `${after.name} can no longer sign in.`, data: after })
})

async function assertAnotherAdminRemains(excludingUserId: string): Promise<void> {
  const others = await prisma.user.count({
    where: {
      id: { not: excludingUserId },
      status: 'ACTIVE',
      role: { name: SUPER_ROLE },
    },
  })
  if (others === 0) {
    throw new AppError(
      'This is the last active administrator. Give someone else the Admin role first, or nobody will be able to manage the ERP.',
      400,
      'LAST_ADMIN',
    )
  }
}

/** Anyone may change their own password, whatever their role. */
router.post('/change-password', async (req: AuthRequest, res) => {
  if (!req.user) throw new AppError('Unauthorized', 401)
  const { currentPassword, newPassword } = changeOwnPasswordSchema.parse(req.body)

  const user = await prisma.user.findUnique({ where: { id: req.user.id } })
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND')

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new AppError('Your current password is not correct', 400, 'BAD_PASSWORD')
  }
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw new AppError('Choose a password you have not used here before', 400, 'SAME_PASSWORD')
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) },
  })

  await writeAuditLog(req, {
    module: ADMIN,
    action: 'UPDATE',
    entityType: 'User',
    entityId: user.id,
    after: { passwordChanged: true },
  })

  res.json({ success: true, message: 'Password changed.' })
})

// ═══════════════════════════════════════════
// ROLES AND PERMISSIONS
// ═══════════════════════════════════════════

/**
 * Plain-English names for the permission matrix. The matrix itself is seeded as
 * bare module/action pairs, which read as jargon on screen.
 */
const MODULE_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  masters: 'Master data',
  sales: 'Sales',
  purchase: 'Purchase',
  inventory: 'Inventory',
  production: 'Production',
  accounts: 'Accounts',
  hr: 'HR & Payroll',
  vhagar: 'VHAGAR brand',
  maintenance: 'Maintenance',
  ai: 'AI assistant',
  settings: 'Settings',
  admin: 'Users & roles',
}

const ACTION_LABELS: Record<string, string> = {
  view: 'View',
  create: 'Add',
  edit: 'Edit',
  delete: 'Remove',
  approve: 'Approve',
  export: 'Export',
}

router.get('/permissions', requirePermission(ADMIN, 'view'), async (_req, res) => {
  const permissions = await prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { action: 'asc' }] })

  const modules = new Map<string, { module: string; label: string; actions: { action: string; label: string; key: string }[] }>()
  for (const p of permissions) {
    const entry = modules.get(p.module) ?? {
      module: p.module,
      label: MODULE_LABELS[p.module] ?? p.module,
      actions: [],
    }
    entry.actions.push({ action: p.action, label: ACTION_LABELS[p.action] ?? p.action, key: `${p.module}:${p.action}` })
    modules.set(p.module, entry)
  }

  // Keep the on-screen order the same as the sidebar rather than alphabetical.
  const order = Object.keys(MODULE_LABELS)
  const data = [...modules.values()].sort(
    (a, b) => (order.indexOf(a.module) + 1 || 99) - (order.indexOf(b.module) + 1 || 99),
  )

  res.json({ success: true, data, actions: Object.entries(ACTION_LABELS).map(([action, label]) => ({ action, label })) })
})

router.get('/roles', requirePermission(ADMIN, 'view'), async (_req, res) => {
  const roles = await prisma.role.findMany({
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    include: {
      permissions: { include: { permission: true } },
      _count: { select: { users: true } },
    },
  })

  res.json({
    success: true,
    data: roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      userCount: r._count.users,
      // The Admin role bypasses the matrix in the auth middleware, so listing
      // its rows and pretending they can be revoked would be misleading.
      unrestricted: r.name === SUPER_ROLE,
      permissions: r.permissions.map((rp) => `${rp.permission.module}:${rp.permission.action}`),
    })),
  })
})

router.post('/roles', requirePermission(ADMIN, 'create'), async (req: AuthRequest, res) => {
  const data = createRoleSchema.parse(req.body)

  const clash = await prisma.role.findUnique({ where: { name: data.name } })
  if (clash) throw new AppError('A role with that name already exists', 409, 'DUPLICATE_ROLE')

  const permissionIds = await resolvePermissionIds(data.permissions)

  const role = await prisma.role.create({
    data: {
      name: data.name,
      description: data.description ?? null,
      permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
    },
  })

  await writeAuditLog(req, {
    module: ADMIN,
    action: 'CREATE',
    entityType: 'Role',
    entityId: role.id,
    after: { ...role, permissions: data.permissions },
  })

  res.status(201).json({ success: true, data: role })
})

router.patch('/roles/:id', requirePermission(ADMIN, 'edit'), async (req: AuthRequest, res) => {
  const data = updateRoleSchema.parse(req.body)

  const before = await prisma.role.findUnique({
    where: { id: req.params.id },
    include: { permissions: { include: { permission: true } } },
  })
  if (!before) throw new AppError('Role not found', 404, 'NOT_FOUND')

  if (before.isSystem && data.name && data.name !== before.name) {
    throw new AppError('Built-in roles cannot be renamed', 400, 'SYSTEM_ROLE')
  }
  if (before.name === SUPER_ROLE && data.permissions) {
    throw new AppError(
      'The Admin role always has full access. Create a separate role if you need a narrower one.',
      400,
      'SYSTEM_ROLE',
    )
  }

  if (data.name && data.name !== before.name) {
    const clash = await prisma.role.findUnique({ where: { name: data.name } })
    if (clash) throw new AppError('A role with that name already exists', 409, 'DUPLICATE_ROLE')
  }

  // Permissions are replaced wholesale in one transaction, so a half-applied
  // change can never leave a role with an arbitrary mix of old and new grants.
  const permissionIds = data.permissions ? await resolvePermissionIds(data.permissions) : null

  const after = await prisma.$transaction(async (tx) => {
    if (permissionIds) {
      await tx.rolePermission.deleteMany({ where: { roleId: before.id } })
      if (permissionIds.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId: before.id, permissionId })),
        })
      }
    }

    return tx.role.update({
      where: { id: before.id },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description ?? null } : {}),
      },
      include: { permissions: { include: { permission: true } } },
    })
  })

  await writeAuditLog(req, {
    module: ADMIN,
    action: 'UPDATE',
    entityType: 'Role',
    entityId: after.id,
    before: {
      name: before.name,
      description: before.description,
      permissions: before.permissions.map((rp) => `${rp.permission.module}:${rp.permission.action}`),
    },
    after: {
      name: after.name,
      description: after.description,
      permissions: after.permissions.map((rp) => `${rp.permission.module}:${rp.permission.action}`),
    },
  })

  res.json({
    success: true,
    // Changed grants only reach a signed-in user when their access token is
    // renewed, which is fifteen minutes at the outside.
    message: 'Saved. People already signed in pick up the change within 15 minutes.',
    data: {
      id: after.id,
      name: after.name,
      description: after.description,
      permissions: after.permissions.map((rp) => `${rp.permission.module}:${rp.permission.action}`),
    },
  })
})

router.delete('/roles/:id', requirePermission(ADMIN, 'delete'), async (req: AuthRequest, res) => {
  const role = await prisma.role.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { users: true } } },
  })
  if (!role) throw new AppError('Role not found', 404, 'NOT_FOUND')

  if (role.isSystem) throw new AppError('Built-in roles cannot be deleted', 400, 'SYSTEM_ROLE')
  if (role._count.users > 0) {
    throw new AppError(
      `${role._count.users} ${role._count.users === 1 ? 'person is' : 'people are'} still on this role. Move them to another role first.`,
      400,
      'ROLE_IN_USE',
    )
  }

  await prisma.role.delete({ where: { id: role.id } })

  await writeAuditLog(req, {
    module: ADMIN,
    action: 'DELETE',
    entityType: 'Role',
    entityId: role.id,
    before: { name: role.name, description: role.description },
  })

  res.json({ success: true, message: `Role "${role.name}" deleted.` })
})

/** Turns "sales:create" keys into permission ids, rejecting anything unknown. */
async function resolvePermissionIds(keys: string[]): Promise<string[]> {
  if (keys.length === 0) return []

  const wanted = new Set(keys)
  const permissions = await prisma.permission.findMany()
  const found = permissions.filter((p) => wanted.has(`${p.module}:${p.action}`))

  if (found.length !== wanted.size) {
    const known = new Set(permissions.map((p) => `${p.module}:${p.action}`))
    const unknown = [...wanted].filter((k) => !known.has(k))
    throw new AppError(`Unknown permission: ${unknown.join(', ')}`, 400, 'UNKNOWN_PERMISSION')
  }

  return found.map((p) => p.id)
}

// ═══════════════════════════════════════════
// DOCUMENT NUMBERING
// ═══════════════════════════════════════════

/** What each seeded document type is called in conversation. */
const DOC_TYPE_LABELS: Record<string, string> = {
  SO: 'Sales order',
  PO: 'Purchase order',
  MO: 'Manufacturing order',
  GRN: 'Goods receipt',
  INV: 'Sales invoice',
  MR: 'Material requisition',
  DC: 'Delivery challan',
  VCH: 'Voucher',
}

/** SO-2425-0001 — the number the next document of this type will carry. */
function sampleNumber(s: {
  prefix: string
  separator: string
  financialYear: string
  lastNumber: number
  padding: number
}): string {
  return [s.prefix, s.financialYear, String(s.lastNumber + 1).padStart(s.padding, '0')].join(s.separator)
}

router.get('/number-series', requirePermission(SETTINGS, 'view'), async (_req, res) => {
  const series = await prisma.numberSeries.findMany({
    where: { companyId: await companyId() },
    orderBy: [{ financialYear: 'desc' }, { docType: 'asc' }],
  })

  res.json({
    success: true,
    data: series.map((s) => ({
      ...s,
      label: DOC_TYPE_LABELS[s.docType] ?? s.docType,
      nextNumber: sampleNumber(s),
    })),
  })
})

router.post('/number-series', requirePermission(SETTINGS, 'create'), async (req: AuthRequest, res) => {
  const data = createNumberSeriesSchema.parse(req.body)
  const company = await companyId()

  const clash = await prisma.numberSeries.findUnique({
    where: {
      companyId_docType_financialYear: {
        companyId: company,
        docType: data.docType,
        financialYear: data.financialYear,
      },
    },
  })
  if (clash) {
    throw new AppError(
      `${data.docType} already has a series for ${data.financialYear}`,
      409,
      'DUPLICATE_SERIES',
    )
  }

  const created = await prisma.numberSeries.create({ data: { ...data, companyId: company } })

  await writeAuditLog(req, {
    module: SETTINGS,
    action: 'CREATE',
    entityType: 'NumberSeries',
    entityId: created.id,
    after: created,
  })

  res.status(201).json({ success: true, data: { ...created, nextNumber: sampleNumber(created) } })
})

router.patch('/number-series/:id', requirePermission(SETTINGS, 'edit'), async (req: AuthRequest, res) => {
  const data = updateNumberSeriesSchema.parse(req.body)

  const before = await prisma.numberSeries.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('Number series not found', 404, 'NOT_FOUND')

  // The update is partial, so the length rule has to be re-checked against the
  // pieces that are not changing. A document number over sixteen characters is
  // not valid under Rule 46(b), whichever field pushed it over.
  const merged = {
    prefix: data.prefix ?? before.prefix,
    financialYear: before.financialYear,
    padding: data.padding ?? before.padding,
    separator: data.separator ?? before.separator,
  }
  const sample = [merged.prefix, merged.financialYear, '9'.repeat(merged.padding)].join(
    merged.separator,
  )
  if (sample.length > 16) {
    throw new AppError(
      `That would produce "${sample}" — ${sample.length} characters. The law allows 16. Shorten the prefix.`,
      400,
      'DOC_NUMBER_TOO_LONG',
    )
  }

  // Changing the prefix once documents exist produces two different formats in
  // the same year, which is legal but confusing, so it is called out.
  const after = await prisma.numberSeries.update({ where: { id: before.id }, data })

  await writeAuditLog(req, {
    module: SETTINGS,
    action: 'UPDATE',
    entityType: 'NumberSeries',
    entityId: after.id,
    before,
    after,
  })

  res.json({
    success: true,
    data: { ...after, nextNumber: sampleNumber(after) },
    message:
      before.lastNumber > 0 && data.prefix && data.prefix !== before.prefix
        ? `${before.lastNumber} document(s) already use the old prefix. They keep their existing numbers.`
        : undefined,
  })
})

// ═══════════════════════════════════════════
// TAX RATES
// ═══════════════════════════════════════════

router.get('/tax-rates', requirePermission(SETTINGS, 'view'), async (_req, res) => {
  const rates = await prisma.taxRate.findMany({
    where: { companyId: await companyId() },
    orderBy: { rate: 'asc' },
  })
  res.json({ success: true, data: rates.map((r) => ({ ...r, rate: Number(r.rate) })) })
})

router.post('/tax-rates', requirePermission(SETTINGS, 'create'), async (req: AuthRequest, res) => {
  const data = createTaxRateSchema.parse(req.body)
  const company = await companyId()

  const created = await prisma.$transaction(async (tx) => {
    if (data.isDefault) await tx.taxRate.updateMany({ where: { companyId: company }, data: { isDefault: false } })
    return tx.taxRate.create({ data: { ...data, companyId: company } })
  })

  await writeAuditLog(req, {
    module: SETTINGS,
    action: 'CREATE',
    entityType: 'TaxRate',
    entityId: created.id,
    after: created,
  })

  res.status(201).json({ success: true, data: { ...created, rate: Number(created.rate) } })
})

router.patch('/tax-rates/:id', requirePermission(SETTINGS, 'edit'), async (req: AuthRequest, res) => {
  const data = updateTaxRateSchema.parse(req.body)

  const before = await prisma.taxRate.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('Tax rate not found', 404, 'NOT_FOUND')

  // Exactly one rate may be the default, so setting a new one clears the rest
  // in the same transaction.
  const after = await prisma.$transaction(async (tx) => {
    if (data.isDefault) {
      await tx.taxRate.updateMany({
        where: { companyId: before.companyId, id: { not: before.id } },
        data: { isDefault: false },
      })
    }
    return tx.taxRate.update({ where: { id: before.id }, data })
  })

  await writeAuditLog(req, {
    module: SETTINGS,
    action: 'UPDATE',
    entityType: 'TaxRate',
    entityId: after.id,
    before,
    after,
  })

  res.json({ success: true, data: { ...after, rate: Number(after.rate) } })
})

router.delete('/tax-rates/:id', requirePermission(SETTINGS, 'delete'), async (req: AuthRequest, res) => {
  const before = await prisma.taxRate.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('Tax rate not found', 404, 'NOT_FOUND')

  const after = await prisma.taxRate.update({ where: { id: before.id }, data: { isActive: false } })

  await writeAuditLog(req, {
    module: SETTINGS,
    action: 'DELETE',
    entityType: 'TaxRate',
    entityId: after.id,
    before,
    after,
  })

  res.json({ success: true, message: `${before.name} is no longer offered on new documents.` })
})

// ═══════════════════════════════════════════
// PREFERENCES
// ═══════════════════════════════════════════

/**
 * The subset every signed-in user needs in order to render a screen correctly.
 *
 * Only Admin and MD hold settings:view, but a stitching supervisor still has to
 * see dates in the company's format and the right number of rows per page, so
 * this one is open to anyone with a valid token and carries nothing sensitive.
 */
const DISPLAY_PREFERENCE_KEYS = ['rowsPerPage', 'dateFormat', 'qcInDailyProduction'] as const

router.get('/app', async (_req, res) => {
  const values = await getPreferences()
  const data: Record<string, unknown> = {}
  for (const key of DISPLAY_PREFERENCE_KEYS) data[key] = values[key]
  res.json({ success: true, data })
})

router.get('/preferences', requirePermission(SETTINGS, 'view'), async (_req, res) => {
  const values = await getPreferences()
  res.json({ success: true, data: values, definitions: PREFERENCES })
})

router.patch('/preferences', requirePermission(SETTINGS, 'edit'), async (req: AuthRequest, res) => {
  const patch = preferencesPatchSchema.parse(req.body)
  const company = await companyId()

  const before = await getPreferences()

  for (const [key, value] of Object.entries(patch)) {
    await prisma.appSetting.upsert({
      where: { companyId_key: { companyId: company, key } },
      update: { value: value as never },
      create: { companyId: company, key, value: value as never },
    })
  }

  invalidatePreferences()
  const after = await getPreferences()

  await writeAuditLog(req, {
    module: SETTINGS,
    action: 'UPDATE',
    entityType: 'Preferences',
    entityId: company,
    before,
    after,
  })

  res.json({ success: true, data: after })
})

// ═══════════════════════════════════════════
// PRINTED DOCUMENTS
// ═══════════════════════════════════════════

/** Every document type we can print, in the order it appears on the tab. */
const DOC_TYPES = [
  { docType: 'INV', label: 'Sales Invoice', defaultTitle: 'TAX INVOICE' },
  { docType: 'PO', label: 'Purchase Order', defaultTitle: 'PURCHASE ORDER' },
  { docType: 'DC', label: 'Delivery Challan', defaultTitle: 'DELIVERY CHALLAN' },
  { docType: 'JW', label: 'Job Work Challan', defaultTitle: 'DELIVERY CHALLAN (JOB WORK)' },
] as const

const documentTemplateSchema = z.object({
  title: z.string().min(1, 'A heading is required').max(80),
  termsText: z.string().max(4000).optional().nullable(),
  declaration: z.string().max(1000).optional().nullable(),
  footerNote: z.string().max(300).optional().nullable(),
  showHsn: z.boolean().optional(),
  showAmountInWords: z.boolean().optional(),
  showBankDetails: z.boolean().optional(),
  showSignature: z.boolean().optional(),
  copies: z.array(z.string().max(60)).max(4).optional(),
  isActive: z.boolean().optional(),
})

/**
 * Images are held inline as data URLs rather than as files on disk.
 *
 * A logo is a few kilobytes, it belongs to the company record, and keeping it
 * in the database means a backup of the database is a complete backup — no
 * separate uploads folder to lose. The size cap is what stops someone pasting
 * a two-megabyte photograph into a letterhead.
 */
const MAX_IMAGE_BYTES = 400 * 1024

const imageDataUrl = z
  .string()
  .regex(/^data:image\/(png|jpeg|jpg|svg\+xml|webp);base64,/, 'That is not a PNG, JPG, SVG or WebP image')
  .refine((v) => v.length * 0.75 <= MAX_IMAGE_BYTES, {
    message: 'That image is too large. Keep it under 400 KB — a letterhead does not need more.',
  })

const brandingSchema = z.object({
  logoUrl: z.union([imageDataUrl, z.literal('')]).optional().nullable(),
  signatureUrl: z.union([imageDataUrl, z.literal('')]).optional().nullable(),
  bankName: z.string().max(120).optional().nullable(),
  bankBranch: z.string().max(120).optional().nullable(),
  bankAccount: z.string().max(40).optional().nullable(),
  bankIFSC: z
    .union([z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code'), z.literal('')])
    .optional()
    .nullable(),
  upiId: z.string().max(80).optional().nullable(),
})

router.get('/documents', requirePermission(SETTINGS, 'view'), async (_req, res) => {
  const company = await prisma.company.findFirst()
  if (!company) throw new AppError('Company profile not set up yet', 404, 'NOT_FOUND')

  const saved = await prisma.documentTemplate.findMany({ where: { companyId: company.id } })
  const byType = new Map(saved.map((d) => [d.docType, d]))

  res.json({
    success: true,
    data: {
      branding: {
        logoUrl: company.logoUrl,
        signatureUrl: company.signatureUrl,
        bankName: company.bankName,
        bankBranch: company.bankBranch,
        bankAccount: company.bankAccount,
        bankIFSC: company.bankIFSC,
        upiId: company.upiId,
      },
      // Every document type is listed whether or not it has been set up, so the
      // screen shows the full set rather than only what happens to exist.
      documents: DOC_TYPES.map((t) => {
        const row = byType.get(t.docType)
        return {
          docType: t.docType,
          label: t.label,
          title: row?.title ?? t.defaultTitle,
          termsText: row?.termsText ?? null,
          declaration: row?.declaration ?? null,
          footerNote: row?.footerNote ?? null,
          showHsn: row?.showHsn ?? true,
          showAmountInWords: row?.showAmountInWords ?? true,
          showBankDetails: row?.showBankDetails ?? t.docType === 'INV',
          showSignature: row?.showSignature ?? true,
          copies: row?.copies ?? [],
          isActive: row?.isActive ?? true,
          configured: Boolean(row),
        }
      }),
    },
  })
})

router.patch('/documents/branding', requirePermission(SETTINGS, 'edit'), async (req: AuthRequest, res) => {
  const data = brandingSchema.parse(req.body)

  const before = await prisma.company.findFirst()
  if (!before) throw new AppError('Company profile not set up yet', 404, 'NOT_FOUND')

  // An empty string means "remove this", which is different from not sending it.
  const clean = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, v === '' ? null : v]),
  )

  const after = await prisma.company.update({ where: { id: before.id }, data: clean })

  await writeAuditLog(req, {
    module: SETTINGS,
    action: 'UPDATE',
    entityType: 'DocumentBranding',
    entityId: after.id,
    // The images are large and unreadable in a log; record only that they moved.
    before: { ...before, logoUrl: Boolean(before.logoUrl), signatureUrl: Boolean(before.signatureUrl) },
    after: { ...after, logoUrl: Boolean(after.logoUrl), signatureUrl: Boolean(after.signatureUrl) },
  })

  res.json({ success: true, message: 'Saved.' })
})

router.patch('/documents/:docType', requirePermission(SETTINGS, 'edit'), async (req: AuthRequest, res) => {
  const docType = req.params.docType.toUpperCase()
  const known = DOC_TYPES.find((t) => t.docType === docType)
  if (!known) throw new AppError(`There is no ${docType} document`, 404, 'UNKNOWN_DOC_TYPE')

  const data = documentTemplateSchema.parse(req.body)
  const company = await companyId()

  const before = await prisma.documentTemplate.findUnique({
    where: { companyId_docType: { companyId: company, docType } },
  })

  const after = await prisma.documentTemplate.upsert({
    where: { companyId_docType: { companyId: company, docType } },
    update: {
      ...data,
      termsText: data.termsText ?? null,
      declaration: data.declaration ?? null,
      footerNote: data.footerNote ?? null,
    },
    create: {
      companyId: company,
      docType,
      title: data.title,
      termsText: data.termsText ?? null,
      declaration: data.declaration ?? null,
      footerNote: data.footerNote ?? null,
      showHsn: data.showHsn ?? true,
      showAmountInWords: data.showAmountInWords ?? true,
      showBankDetails: data.showBankDetails ?? docType === 'INV',
      showSignature: data.showSignature ?? true,
      copies: data.copies ?? [],
      isActive: data.isActive ?? true,
    },
  })

  await writeAuditLog(req, {
    module: SETTINGS,
    action: before ? 'UPDATE' : 'CREATE',
    entityType: 'DocumentTemplate',
    entityId: after.id,
    before,
    after,
  })

  res.json({ success: true, data: { ...after, label: known.label } })
})

// ═══════════════════════════════════════════
// ASSISTANT
// ═══════════════════════════════════════════

const aiSettingsSchema = z.object({
  // An empty string clears the key; undefined leaves it alone.
  apiKey: z.string().max(200).optional(),
  model: z.string().max(60).optional(),
  enabled: z.boolean().optional(),
  dailySummary: z.boolean().optional(),
})

router.get('/ai', requirePermission(SETTINGS, 'view'), async (_req, res) => {
  const config = await getAiConfig(true)

  res.json({
    success: true,
    data: {
      // The key itself is never sent back — only enough to show one is saved.
      configured: Boolean(config.apiKey),
      keyHint: maskKey(config.apiKey),
      source: config.source,
      model: config.model,
      enabled: config.enabled,
      dailySummary: config.dailySummary,
      models: AI_MODELS,
      /** Explains the guardrail on screen rather than offering it as a toggle. */
      permissionScoped: true,
    },
  })
})

router.patch('/ai', requirePermission(SETTINGS, 'edit'), async (req: AuthRequest, res) => {
  const data = aiSettingsSchema.parse(req.body)
  const company = await companyId()

  if (data.model && !AI_MODELS.some((m) => m.value === data.model)) {
    throw new AppError('That model is not one we support', 400, 'INVALID_MODEL')
  }

  await saveAiConfig(company, {
    ...(data.apiKey !== undefined ? { apiKey: data.apiKey.trim() || null } : {}),
    ...(data.model !== undefined ? { model: data.model } : {}),
    ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
    ...(data.dailySummary !== undefined ? { dailySummary: data.dailySummary } : {}),
  })

  const after = await getAiConfig(true)

  // The key must never reach the audit trail, so only the fact of a change is
  // recorded alongside the settings that are safe to keep.
  await writeAuditLog(req, {
    module: SETTINGS,
    action: 'UPDATE',
    entityType: 'AssistantSettings',
    entityId: company,
    after: {
      apiKeyChanged: data.apiKey !== undefined,
      model: after.model,
      enabled: after.enabled,
      dailySummary: after.dailySummary,
    },
  })

  res.json({
    success: true,
    data: {
      configured: Boolean(after.apiKey),
      keyHint: maskKey(after.apiKey),
      source: after.source,
      model: after.model,
      enabled: after.enabled,
      dailySummary: after.dailySummary,
    },
  })
})

/**
 * Asks the model a trivial question and reports what came back.
 *
 * A key that merely exists proves nothing — it can be revoked, mistyped, or out
 * of quota. This screen should say whether the assistant actually works.
 */
router.post('/ai/test', requirePermission(SETTINGS, 'edit'), async (req, res) => {
  const { apiKey } = z.object({ apiKey: z.string().optional() }).parse(req.body ?? {})
  const config = await getAiConfig(true)
  const key = apiKey?.trim() || config.apiKey

  if (!key) {
    return res.json({ success: false, message: 'No API key to test. Paste one above first.' })
  }

  const started = Date.now()
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai')
    const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: config.model })
    const result = await model.generateContent('Reply with the single word: ready')
    const text = result.response.text().trim().slice(0, 40)

    res.json({
      success: true,
      message: `Answered in ${Date.now() - started} ms — "${text}"`,
      model: config.model,
    })
  } catch (err) {
    const raw = (err as Error).message ?? ''
    // Google's errors are long and full of JSON; turn the common ones into
    // something a mill owner can act on.
    const message = /API_KEY_INVALID|API key not valid/i.test(raw)
      ? 'That key was refused. Check you copied all of it from Google AI Studio.'
      : /quota|RESOURCE_EXHAUSTED|429/i.test(raw)
        ? 'The key works, but its free quota is used up for now. Try again later or add billing.'
        : /not found|404/i.test(raw)
          ? `The key works, but the model "${config.model}" is not available to it. Try another model.`
          : `Could not reach Google: ${raw.slice(0, 160)}`

    res.json({ success: false, message })
  }
})

// ═══════════════════════════════════════════
// ACTIVITY TRAIL
// ═══════════════════════════════════════════

router.get('/activity', requirePermission(ADMIN, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

  const where: Record<string, unknown> = {}
  if (typeof req.query.module === 'string' && req.query.module) where.module = req.query.module
  if (typeof req.query.action === 'string' && req.query.action) where.action = req.query.action
  if (typeof req.query.userId === 'string' && req.query.userId) where.userId = req.query.userId

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ])

  res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      module: r.module,
      moduleLabel: MODULE_LABELS[r.module] ?? r.module,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      user: r.user,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt,
      changed: changedFields(r.before, r.after),
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

/**
 * Names the fields that actually differ between two audit snapshots. The full
 * before/after objects are far too wide to read in a list, and on an update
 * almost every field is unchanged.
 */
function changedFields(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return []

  const a = before as Record<string, unknown>
  const b = after as Record<string, unknown>
  const skip = new Set(['updatedAt', 'createdAt'])

  return Object.keys(b)
    .filter((k) => !skip.has(k))
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}

// ═══════════════════════════════════════════
// SYSTEM
// ═══════════════════════════════════════════

/**
 * What is connected and what is not. Every answer is measured rather than
 * assumed, because a status screen that reports from configuration alone will
 * happily claim a dead database is fine.
 */
router.get('/system', requirePermission(SETTINGS, 'view'), async (_req, res) => {
  const startedAt = Date.now()

  let database: { connected: boolean; latencyMs: number | null; error?: string }
  try {
    await prisma.$queryRaw`SELECT 1`
    database = { connected: true, latencyMs: Date.now() - startedAt }
  } catch (err) {
    database = { connected: false, latencyMs: null, error: (err as Error).message }
  }

  const [users, roles, auditEntries, company] = await Promise.all([
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.role.count(),
    prisma.auditLog.count(),
    prisma.company.findFirst({ select: { name: true, currentFY: true } }),
  ])

  // The .env template ships every credential as "your-something". Treating one
  // of those as a real value makes this screen claim a connection that does not
  // exist, which is worse than saying nothing — so a placeholder counts as unset.
  const configured = (...names: string[]) =>
    names.every((name) => {
      const value = process.env[name]
      return Boolean(value) && !value!.startsWith('your-')
    })

  const aiConfigured = configured('GEMINI_API_KEY')
  const emailConfigured = configured('SMTP_HOST', 'SMTP_USER', 'SMTP_PASS')
  const whatsappConfigured = configured('WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID')

  res.json({
    success: true,
    data: {
      company: company?.name ?? null,
      financialYear: company?.currentFY ?? null,
      database,
      counts: { activeUsers: users, roles, auditEntries },
      connections: [
        {
          key: 'database',
          name: 'Database (Supabase)',
          connected: database.connected,
          detail: database.connected
            ? `Answered in ${database.latencyMs} ms`
            : 'Not reachable — the ERP cannot save anything',
        },
        {
          key: 'ai',
          name: 'AI assistant (Gemini)',
          connected: aiConfigured,
          detail: aiConfigured
            ? `Model ${process.env.GEMINI_MODEL ?? 'gemini-2.0-flash-exp'}`
            : 'No API key set, so the assistant cannot answer',
        },
        {
          key: 'whatsapp',
          name: 'WhatsApp notifications',
          connected: whatsappConfigured,
          detail: whatsappConfigured ? 'Access token set' : 'Not set up yet',
        },
        {
          key: 'email',
          name: 'Email notifications',
          connected: emailConfigured,
          detail: emailConfigured
            ? `Sending through ${process.env.SMTP_HOST}`
            : 'Not set up yet — no mail will go out',
        },
      ],
      server: {
        environment: process.env.NODE_ENV ?? 'development',
        node: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
      },
    },
  })
})

export default router
