import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { accessFor, grantsAllow, isAdminRole } from '../lib/access'
import { SCREENS, SUPER_ROLE, moduleOf, screenForPath } from '../lib/accessCatalog'
import { runAs } from '../lib/requestContext'

export interface AuthRequest extends Request {
  user?: {
    id: string
    email: string
    name: string
    roleId: string
    role: string
    /** "key:action" grants, module-wide ("masters:create") or one screen ("purchase.orders:create"). */
    permissions?: string[]
    /** The Super Admin role: every screen and every action, whatever the matrix says. */
    superAdmin?: boolean
  }
}

/**
 * Whether this user holds an administrator's role — Super Admin or Admin —
 * which may, for instance, approve its own requisitions.
 */
export const isAdmin = (user?: { role?: string } | null) => isAdminRole(user?.role)

/**
 * Checks the token, then reads who this person is now: their role and what it
 * allows come from the database (kept for half a minute), not from the token,
 * so a change in Settings applies within seconds and a deactivated account is
 * turned away on its next request.
 */
export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'No token provided' })
  }

  const token = authHeader.split(' ')[1]

  let decoded: AuthRequest['user']
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET!) as AuthRequest['user']
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ success: false, message: 'Token expired', code: 'TOKEN_EXPIRED' })
    }
    return res.status(401).json({ success: false, message: 'Invalid token' })
  }

  try {
    const access = decoded?.id ? await accessFor(decoded.id) : null
    if (!access || access.status !== 'ACTIVE') {
      return res.status(401).json({
        success: false,
        message: 'This account can no longer sign in. Ask an administrator.',
        code: 'ACCOUNT_INACTIVE',
      })
    }
    req.user = {
      ...decoded!,
      roleId: access.roleId,
      role: access.role,
      permissions: access.grants,
      superAdmin: access.superAdmin,
    }
    // The rest of the request runs as this user, so the stock writer can say who moved stock.
    runAs(req.user.id ?? null, () => next())
  } catch (err) {
    next(err)
  }
}

export const requireRole = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Unauthorized' })
    if (req.user.superAdmin) return next()
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions' })
    }
    next()
  }
}

/**
 * The same question requirePermission asks, but as a plain answer.
 *
 * Some screens are open to everyone and only *parts* of them are restricted —
 * the dashboard shows production to the whole mill but must not show what
 * customers owe to somebody with no accounts access. Guarding the whole route
 * would take the dashboard away from them; guarding nothing hands out the
 * figures. This lets one response leave out what one reader may not see.
 *
 * `key` is a module ("purchase") or a screen ("purchase.orders").
 */
export function userCan(user: AuthRequest['user'], key: string, action: string): boolean {
  if (!user) return false
  if (user.superAdmin || user.role === SUPER_ROLE) return true
  return grantsAllow(user.permissions ?? [], key, action)
}

/**
 * The dedicated right to change an extra charge's GST on a sales document
 * (Settings → People: "Override Sales Charge GST"). Granted only by name;
 * Masters edit rights have nothing to do with it.
 */
export const mayOverrideSaleChargeGst = (user: AuthRequest['user']) => userCan(user, 'sales.charge-gst', 'edit')

const ACTION_WORDS: Record<string, string> = {
  view: 'open',
  create: 'add to',
  edit: 'change',
  delete: 'delete from',
  approve: 'approve on',
  post: 'post from',
  export: 'export from',
}

/**
 * Guards a route by module and action.
 *
 * Viewing is allowed on the module as a whole: screens read each other's
 * lists — a goods receipt picks from the purchase orders — so seeing one
 * screen has to mean reading the module's records. Which screens a person can
 * open is decided by the menu.
 *
 * Every other action is checked against the one screen the request belongs
 * to, found from its address in the access catalogue: a role allowed to add
 * goods receipts is not thereby allowed to add purchase orders. An address no
 * screen claims falls back to the module, as before.
 */
export const requirePermission = (module: string, action: string) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' })
    }
    if (req.user.superAdmin) return next()

    let key = module
    if (action !== 'view') {
      const screen = screenForPath(`${req.baseUrl}${req.path}`.replace(/\/+$/, ''))
      // Only a screen of the module the route belongs to: a routing kept
      // under the masters API is a masters screen, whatever menu it sits in.
      if (screen && moduleOf(screen) === module) key = screen
    }

    if (grantsAllow(req.user.permissions ?? [], key, action)) return next()

    const where = SCREENS.get(key)?.label ?? module
    return res.status(403).json({
      success: false,
      message: `Your role does not allow you to ${ACTION_WORDS[action] ?? action} ${where}. Ask an administrator to change it in Settings → People.`,
      code: 'FORBIDDEN',
      required: `${key}:${action}`,
    })
  }
}
