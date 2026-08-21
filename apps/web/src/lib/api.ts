const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000/api'

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

export const tokens = {
  access: () => (typeof window === 'undefined' ? null : localStorage.getItem(ACCESS_KEY)),
  refresh: () => (typeof window === 'undefined' ? null : localStorage.getItem(REFRESH_KEY)),
  set: (access: string, refresh?: string) => {
    localStorage.setItem(ACCESS_KEY, access)
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh)
  },
  clear: () => {
    localStorage.removeItem(ACCESS_KEY)
    localStorage.removeItem(REFRESH_KEY)
    localStorage.removeItem('user')
  },
}

/**
 * Access tokens live 15 minutes, so an expiry mid-session is normal rather than
 * exceptional. A single shared promise does the refresh: without it, a screen
 * firing six parallel requests would start six refreshes, and because the API
 * rotates tokens, five of them would race and lose.
 */
let refreshInFlight: Promise<string | null> | null = null

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = tokens.refresh()
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

      tokens.set(body.accessToken)
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

async function request<T>(path: string, init: RequestInit = {}, isRetry = false): Promise<T> {
  const token = tokens.access()

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })

  if (res.status === 401 && !isRetry) {
    const fresh = await refreshAccessToken()
    if (fresh) return request<T>(path, init, true)

    tokens.clear()
    if (typeof window !== 'undefined') window.location.href = '/login'
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

function toQuery(params: ListParams = {}): string {
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
 * The master endpoints all share one shape, so each resource gets the same five
 * calls without restating them.
 */
export function masterResource<T>(resource: string) {
  const base = `/masters/${resource}`
  return {
    list: (params?: ListParams) => api.get<Paginated<T>>(`${base}${toQuery(params)}`),
    get: (id: string) => api.get<Single<T>>(`${base}/${id}`),
    create: (data: Partial<T>) => api.post<Single<T>>(base, data),
    update: (id: string, data: Partial<T>) => api.patch<Single<T>>(`${base}/${id}`, data),
    deactivate: (id: string) => api.delete<{ success: boolean; message: string }>(`${base}/${id}`),
  }
}

export const currentUser = () => {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem('user')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
