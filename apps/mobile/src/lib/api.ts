import * as SecureStore from 'expo-secure-store'

/**
 * The phone's connection to the ERP.
 *
 * A port of apps/web/src/lib/api.ts rather than a fresh attempt: the refresh
 * handling there solves a real race, and the API contract is identical, so the
 * two clients should behave identically too. Two things had to change.
 *
 * Tokens live in the phone's encrypted store, not in plain storage. They are
 * credentials, and a rooted phone or a careless backup can read anything kept
 * in the clear. That store is asynchronous, so reading a token is now an await.
 *
 * And a phone is not a browser: it has no address bar to send somewhere on
 * expiry. Instead this reports that the session ended, and the navigation layer
 * decides what to show.
 */

const DEFAULT_API = 'https://ld-erp-api.onrender.com/api'

/**
 * Set EXPO_PUBLIC_API_URL to point a build at a different server. A phone
 * cannot reach "localhost" — that is the phone itself — so testing against a
 * development machine means its address on the network, e.g.
 * http://192.168.50.127:5000/api
 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_API

export interface Paginated<T> {
  success: boolean
  data: T[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

export interface Single<T> {
  success: boolean
  data: T
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    /** Field-level messages from Zod, keyed by path. */
    public fieldErrors?: Record<string, string>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const ACCESS_KEY = 'access_token'
const REFRESH_KEY = 'refresh_token'
const USER_KEY = 'signed_in_user'

export const tokens = {
  access: () => SecureStore.getItemAsync(ACCESS_KEY),
  refresh: () => SecureStore.getItemAsync(REFRESH_KEY),
  async set(access: string, refresh?: string) {
    await SecureStore.setItemAsync(ACCESS_KEY, access)
    if (refresh) await SecureStore.setItemAsync(REFRESH_KEY, refresh)
  },
  async clear() {
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_KEY),
      SecureStore.deleteItemAsync(REFRESH_KEY),
      SecureStore.deleteItemAsync(USER_KEY),
    ])
  },
}

export const storedUser = {
  get: async () => {
    const raw = await SecureStore.getItemAsync(USER_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  },
  set: (user: unknown) => SecureStore.setItemAsync(USER_KEY, JSON.stringify(user)),
}

/**
 * Called when the session cannot be recovered. The navigation layer registers
 * here so this file does not have to know how the app is laid out.
 */
let onSessionEnded: (() => void) | null = null
export function setSessionEndedHandler(fn: () => void) {
  onSessionEnded = fn
}

/**
 * Access tokens live 15 minutes, so an expiry mid-session is normal rather than
 * exceptional. A single shared promise does the refresh: without it, a screen
 * firing six parallel requests would start six refreshes, and because the API
 * rotates tokens, five of them would race and lose.
 */
let refreshInFlight: Promise<string | null> | null = null

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = await tokens.refresh()
  if (!refreshToken) return null

  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
      if (!res.ok) return null

      const body = await res.json()
      if (!body?.accessToken) return null

      await tokens.set(body.accessToken)
      return body.accessToken as string
    } catch {
      return null
    } finally {
      // Cleared on the next tick so callers awaiting this round all see the
      // same result before a new refresh can begin.
      setTimeout(() => {
        refreshInFlight = null
      }, 0)
    }
  })()

  return refreshInFlight
}

/**
 * The free hosting plan puts the server to sleep after fifteen minutes, and
 * waking it takes the better part of a minute. Without a generous ceiling the
 * first request of the morning would fail on a server that was about to answer.
 */
const REQUEST_TIMEOUT_MS = 70_000

async function request<T>(path: string, init: RequestInit = {}, isRetry = false): Promise<T> {
  const token = await tokens.access()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    })
  } catch (err) {
    // A phone loses signal in a lift and in half of most factory buildings, so
    // this is an ordinary event and has to read like one.
    const aborted = (err as Error)?.name === 'AbortError'
    throw new ApiError(
      aborted
        ? 'The server is taking too long to answer. It may be waking up — try again in a moment.'
        : 'No connection. Check your internet and try again.',
      0,
      aborted ? 'TIMEOUT' : 'OFFLINE',
    )
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401 && !isRetry) {
    const fresh = await refreshAccessToken()
    if (fresh) return request<T>(path, init, true)

    await tokens.clear()
    onSessionEnded?.()
    throw new ApiError('Your session has expired. Please sign in again.', 401, 'SESSION_EXPIRED')
  }

  const body = await res.json().catch(() => null)

  if (!res.ok) {
    throw new ApiError(
      body?.message ?? `Request failed (${res.status})`,
      res.status,
      body?.code,
      toFieldErrors(body?.errors),
    )
  }

  return body as T
}

/** Turns the Zod issue array the API returns into a { fieldName: message } map. */
function toFieldErrors(
  issues: Array<{ path?: (string | number)[]; message?: string }> | undefined,
): Record<string, string> | undefined {
  if (!Array.isArray(issues) || issues.length === 0) return undefined

  const map: Record<string, string> = {}
  for (const issue of issues) {
    const key = issue.path?.join('.') || '_'
    if (issue.message && !map[key]) map[key] = issue.message
  }
  return map
}

export interface ListParams {
  page?: number
  limit?: number
  q?: string
  sort?: string
  order?: 'asc' | 'desc'
  active?: boolean
  [key: string]: string | number | boolean | undefined
}

export function toQuery(params: ListParams = {}): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

/**
 * The master endpoints all share one shape, so each resource gets the same
 * calls without restating them. Mirrors masterResource() on the web.
 */
export function masterResource<T>(resource: string) {
  const base = `/masters/${resource}`
  return {
    list: (params?: ListParams) => api.get<Paginated<T>>(`${base}${toQuery(params)}`),
    get: (id: string) => api.get<Single<T>>(`${base}/${id}`),
    create: (data: Partial<T>) => api.post<Single<T>>(base, data),
    update: (id: string, data: Partial<T>) => api.patch<Single<T>>(`${base}/${id}`, data),
  }
}
