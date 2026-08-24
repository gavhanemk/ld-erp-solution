import { prisma } from '@ld-erp/database'
import { withDefaults } from '../schemas/settings.schemas'

/**
 * Reads company preferences.
 *
 * Preferences are consulted on ordinary requests — the dashboard alone would
 * hit them several times per load — so they are held in memory for a short
 * while rather than fetched every time. The window is deliberately small: a
 * setting changed on one screen should visibly take effect on the next.
 */

const TTL_MS = 30_000

let cache: { values: Record<string, unknown>; expiresAt: number } | null = null

export async function getPreferences(): Promise<Record<string, unknown>> {
  if (cache && cache.expiresAt > Date.now()) return cache.values

  const rows = await prisma.appSetting.findMany()
  const saved: Record<string, unknown> = {}
  for (const row of rows) saved[row.key] = row.value

  const values = withDefaults(saved)
  cache = { values, expiresAt: Date.now() + TTL_MS }
  return values
}

/** Called after a write so the next read reflects it immediately. */
export function invalidatePreferences(): void {
  cache = null
}

export async function getPreference<T>(key: string, fallback: T): Promise<T> {
  const values = await getPreferences()
  return (values[key] as T) ?? fallback
}

/** Preferences stored from a <select> arrive as strings; callers want numbers. */
export async function getNumericPreference(key: string, fallback: number): Promise<number> {
  const raw = (await getPreferences())[key]
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}
