import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Who a request is for, readable by any code the request runs without being
 * passed down to it: the stock writer stamps every movement with it, so the
 * Inward & Outward register can say who moved what.
 *
 * Set by the sign-in check for the rest of the request. Empty for scripts,
 * seeds and anything a timer starts, which have no signed-in user.
 */
const store = new AsyncLocalStorage<{ userId: string | null }>()

/** Runs the rest of a request as this user. */
export function runAs<T>(userId: string | null, fn: () => T): T {
  return store.run({ userId }, fn)
}

/** The signed-in user the current request is for, if any. */
export function currentUserId(): string | null {
  return store.getStore()?.userId ?? null
}
