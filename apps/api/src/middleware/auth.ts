import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

export interface AuthRequest extends Request {
  user?: {
    id: string
    email: string
    name: string
    roleId: string
    role: string
    /** Flattened "module:action" grants, e.g. "masters:create". */
    permissions?: string[]
  }
}

/** Bypasses the permission matrix — the Admin role is always fully authorised. */
const SUPER_ROLE = 'Admin'

/** Whether this user holds the Admin role, which may approve its own requisitions. */
export const isAdmin = (user?: { role?: string } | null) => user?.role === SUPER_ROLE

export const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'No token provided' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as AuthRequest['user']
    req.user = decoded
    next()
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return res
        .status(401)
        .json({ success: false, message: 'Token expired', code: 'TOKEN_EXPIRED' })
    }
    return res.status(401).json({ success: false, message: 'Invalid token' })
  }
}

export const requireRole = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Unauthorized' })
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions' })
    }
    next()
  }
}

/**
 * Guards a route by (module, action) against the permission list baked into the
 * caller's access token.
 *
 * The token is the source of truth, so a permission change only takes effect
 * once the user's access token is refreshed — 15 minutes at most.
 */
/**
 * The same question requirePermission asks, but as a plain answer.
 *
 * Some screens are open to everyone and only *parts* of them are restricted —
 * the dashboard shows production to the whole mill but must not show what
 * customers owe to somebody with no accounts access. Guarding the whole route
 * would take the dashboard away from them; guarding nothing hands out the
 * figures. This lets one response leave out what one reader may not see.
 */
export function userCan(
  user: AuthRequest['user'],
  module: string,
  action: string,
): boolean {
  if (!user) return false
  if (user.role === SUPER_ROLE) return true
  const granted = user.permissions ?? []
  return granted.includes(`${module}:${action}`) || granted.includes(`${module}:*`)
}

export const requirePermission = (module: string, action: string) => {
  const needed = `${module}:${action}`

  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' })
    }

    if (req.user.role === SUPER_ROLE) return next()

    const granted = req.user.permissions ?? []
    if (granted.includes(needed) || granted.includes(`${module}:*`)) {
      return next()
    }

    return res.status(403).json({
      success: false,
      message: `You do not have permission to ${action} ${module}`,
      code: 'FORBIDDEN',
      required: needed,
    })
  }
}
