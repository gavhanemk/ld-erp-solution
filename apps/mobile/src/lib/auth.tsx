import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, tokens, storedUser, setSessionEndedHandler, ApiError } from './api'

/**
 * Who is signed in, and what they are allowed to do.
 *
 * Permissions are not fetched — they already ride inside the sign-in token, the
 * same 78 module:action grants the API checks on every request. The phone reads
 * them to decide which tabs to draw. That is a courtesy to the user, never a
 * security boundary: the server checks again on every call, so a screen reached
 * some other way still gets refused.
 */

export interface SignedInUser {
  id: string
  name: string
  email: string
  role: string
  permissions: string[]
  avatarUrl?: string | null
}

/** Matches SUPER_ROLE in apps/api/src/middleware/auth.ts. */
const SUPER_ROLE = 'Admin'

interface AuthValue {
  user: SignedInUser | null
  /** True while the stored session is being read back at startup. */
  restoring: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  /** `can('purchase', 'create')` — mirrors requirePermission on the server. */
  can: (module: string, action: string) => boolean
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SignedInUser | null>(null)
  const [restoring, setRestoring] = useState(true)

  // Bring back the previous session so the app does not ask for a password
  // every time it is opened.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [saved, token] = await Promise.all([storedUser.get(), tokens.access()])
      if (!cancelled && saved && token) setUser(saved as SignedInUser)
      if (!cancelled) setRestoring(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // The API client cannot navigate on its own, so it reports a dead session
  // here and clearing the user is what sends the app back to sign-in.
  useEffect(() => {
    setSessionEndedHandler(() => setUser(null))
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await api.post<{
      success: boolean
      accessToken: string
      refreshToken: string
      user: SignedInUser
    }>('/auth/login', { email: email.trim().toLowerCase(), password })

    if (!res?.accessToken || !res?.user) {
      throw new ApiError('Signed in, but the server sent nothing back.', 500)
    }

    await tokens.set(res.accessToken, res.refreshToken)
    await storedUser.set(res.user)
    setUser(res.user)
  }, [])

  const signOut = useCallback(async () => {
    await tokens.clear()
    setUser(null)
  }, [])

  const can = useCallback(
    (module: string, action: string) => {
      if (!user) return false
      if (user.role === SUPER_ROLE) return true
      const granted = user.permissions ?? []
      return granted.includes(`${module}:${action}`) || granted.includes(`${module}:*`)
    },
    [user],
  )

  const value = useMemo(
    () => ({ user, restoring, signIn, signOut, can }),
    [user, restoring, signIn, signOut, can],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
