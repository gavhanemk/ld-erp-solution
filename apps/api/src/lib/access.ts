import { prisma } from '@ld-erp/database'
import { ADMIN_ROLES, SUPER_ROLE, SCREENS, moduleOf } from './accessCatalog'

/**
 * Who may do what, worked out from the database rather than carried in the
 * sign-in token.
 *
 * The token used to hold the whole permission list. With a row per screen that
 * list runs to hundreds of entries — too large to send with every request —
 * and a change in Settings took up to fifteen minutes to bite, until the token
 * was renewed. Now the token says only who you are; what you may do is read
 * here, kept for half a minute, and forgotten the moment a role or a person is
 * changed. A deactivated account is refused on its next request, not at its
 * next sign-in.
 */

export interface Access {
  userId: string
  status: string
  roleId: string
  role: string
  superAdmin: boolean
  /** "key:action" grants exactly as stored: module-wide or for one screen. */
  grants: string[]
}

const TTL_MS = 30_000
const cache = new Map<string, { at: number; access: Access | null }>()

export async function accessFor(userId: string): Promise<Access | null> {
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.access

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      status: true,
      roleId: true,
      role: { select: { name: true, permissions: { select: { permission: { select: { module: true, action: true } } } } } },
    },
  })
  const access: Access | null = user
    ? {
        userId: user.id,
        status: user.status,
        roleId: user.roleId,
        role: user.role.name,
        superAdmin: user.role.name === SUPER_ROLE,
        grants: user.role.permissions.map((rp) => `${rp.permission.module}:${rp.permission.action}`),
      }
    : null
  cache.set(userId, { at: Date.now(), access })
  return access
}

/** After a role's grants change, or a person's role or status: read again next time. */
export function forgetAccess(userId?: string) {
  if (userId) cache.delete(userId)
  else cache.clear()
}

/**
 * Whether a set of grants allows an action on a module or on one screen.
 *
 *  - A screen (`purchase.orders`): its own grant, or the module's, which
 *    means every screen in it.
 *  - A module (`purchase`): the module's grant, or the same action on any one
 *    of its screens. This is the question the older guards still ask, and
 *    "may use some part of Purchase" is what they have always meant.
 */
export function grantsAllow(grants: readonly string[], key: string, action: string): boolean {
  const mod = moduleOf(key)
  // A right granted only by name: the module's grant never stands in for it.
  if (EXPLICIT.has(key)) return grants.includes(`${key}:${action}`)
  if (grants.includes(`${key}:${action}`) || grants.includes(`${mod}:${action}`) || grants.includes(`${mod}:*`)) return true
  if (key === mod) {
    const suffix = `:${action}`
    return grants.some((g) => g.startsWith(`${mod}.`) && g.endsWith(suffix) && !EXPLICIT.has(g.split(':')[0]))
  }
  return false
}

/** The screens granted only by name (accessCatalog `explicit`). */
const EXPLICIT = new Set([...SCREENS.values()].filter((sc) => sc.explicit).map((sc) => sc.key))

/** The same, for a permission written whole: "purchase:create". */
export const grantsAllowKey = (grants: readonly string[], permission: string) => {
  const [key, action] = permission.split(':')
  return grantsAllow(grants, key, action)
}

/** Grants with every module-wide one spelt out screen by screen, for the role editor. */
export function expandGrants(grants: readonly string[]): string[] {
  const out = new Set<string>()
  for (const g of grants) {
    const [key, action] = g.split(':')
    // A right granted only by name is never spelt out from a module-wide grant.
    const screens = [...SCREENS.values()].filter((sc) => moduleOf(sc.key) === key && sc.key !== key && !sc.explicit)
    if (key.includes('.') || !screens.length) {
      out.add(g)
      continue
    }
    for (const sc of screens) if ((sc.actions as readonly string[]).includes(action)) out.add(`${sc.key}:${action}`)
  }
  return [...out]
}

export const isSuperRole = (role?: string | null) => role === SUPER_ROLE
export const isAdminRole = (role?: string | null) => !!role && ADMIN_ROLES.includes(role)
