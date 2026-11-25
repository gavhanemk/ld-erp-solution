'use client'

import { useEffect, useState } from 'react'
import { api } from './api'

/**
 * What the signed-in person may open, as the server sees it now.
 *
 * Read from /auth/me when the app starts and every few minutes after, so the
 * menu follows a change made in Settings → People without a sign-out. The
 * server is the guard; this decides only what the screen *offers*: which
 * screens the menu lists, and which page is turned away with a note rather
 * than left to fill with refusals.
 *
 * The screens come from the server with their pages, so there is one list of
 * them — the access catalogue on the API — and not a second one here to drift.
 */

export interface AccessState {
  loaded: boolean
  role: string | null
  superAdmin: boolean
  permissions: string[]
  screens: Array<{ key: string; hrefs: string[] }>
}

export const SUPER_ROLE = 'Super Admin'
const ADMIN_ROLES = [SUPER_ROLE, 'Admin']
/** Super Admin or Admin — the roles allowed a few exceptions, like approving their own requisitions. */
export const isAdminRole = (role?: string | null) => !!role && ADMIN_ROLES.includes(role)

const STORAGE_KEY = 'access'
let state: AccessState = { loaded: false, role: null, superAdmin: false, permissions: [], screens: [] }
const listeners = new Set<(s: AccessState) => void>()

function apply(next: AccessState) {
  state = next
  for (const l of listeners) l(next)
}

/**
 * The same rule as the server's: a screen ("purchase.orders") is allowed by
 * its own grant or its module's; a module ("purchase") by its own grant or the
 * same action on any one of its screens.
 */
export function grantsAllow(grants: readonly string[], key: string, action: string): boolean {
  const mod = key.split('.')[0]
  if (grants.includes(`${key}:${action}`) || grants.includes(`${mod}:${action}`) || grants.includes(`${mod}:*`)) return true
  if (key === mod) return grants.some((g) => g.startsWith(`${mod}.`) && g.endsWith(`:${action}`))
  return false
}

/** Whether to offer this. Fails open until the access has loaded: the server still refuses. */
export function canDo(key: string, action = 'view'): boolean {
  if (!state.loaded) return true
  if (state.superAdmin) return true
  return grantsAllow(state.permissions, key, action)
}

/** The screen a page belongs to, by its address; null when no screen claims it. */
export function screenOf(pathname: string): string | null {
  let best: { key: string; len: number } | null = null
  for (const sc of state.screens)
    for (const h of sc.hrefs)
      if ((pathname === h || pathname.startsWith(h + '/')) && (!best || h.length > best.len)) best = { key: sc.key, len: h.length }
  return best?.key ?? null
}

/** Whether a page may be opened: its screen's View, or yes for a page no screen claims. */
export function canOpen(pathname: string): boolean {
  const key = screenOf(pathname)
  return key ? canDo(key, 'view') : true
}

export async function loadAccess(): Promise<AccessState> {
  if (!state.loaded && typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem(STORAGE_KEY)
      if (cached) apply({ ...JSON.parse(cached), loaded: true })
    } catch {
      // A spoilt copy is replaced by the answer below.
    }
  }
  try {
    const res = await api.get<{
      user: { role: string; superAdmin: boolean; permissions: string[] }
      screens: Array<{ key: string; hrefs: string[] }>
    }>('/auth/me')
    const next: AccessState = {
      loaded: true,
      role: res.user.role,
      superAdmin: Boolean(res.user.superAdmin),
      permissions: res.user.permissions ?? [],
      screens: res.screens ?? [],
    }
    apply(next)
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
        // The stored user feeds can() and the role checks across the app.
        const raw = localStorage.getItem('user')
        if (raw) {
          const u = JSON.parse(raw)
          localStorage.setItem('user', JSON.stringify({ ...u, role: next.role, superAdmin: next.superAdmin, permissions: next.permissions }))
        }
      } catch {
        // Storage full or blocked: this session still has the answer.
      }
    }
  } catch {
    // Unreachable for now: keep what was there, and the server stays the guard.
  }
  return state
}

export function forgetStoredAccess() {
  state = { loaded: false, role: null, superAdmin: false, permissions: [], screens: [] }
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Nothing to clear.
    }
  }
}

export function useAccess(): AccessState {
  const [value, setValue] = useState<AccessState>(state)
  useEffect(() => {
    listeners.add(setValue)
    setValue(state)
    return () => {
      listeners.delete(setValue)
    }
  }, [])
  return value
}
