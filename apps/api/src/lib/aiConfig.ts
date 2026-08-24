import { prisma } from '@ld-erp/database'

/**
 * Assistant configuration.
 *
 * The API key used to come from an environment variable, which meant only
 * somebody who could edit a file on the server could turn the assistant on.
 * It is stored against the company now so it can be set from Settings, and it
 * is never read back out — the screen is told whether a key works, not what it
 * is.
 *
 * These live outside the preference catalogue on purpose: `withDefaults` only
 * returns keys it knows about and `preferencesPatchSchema` rejects the rest, so
 * a key stored here cannot leak through the preferences endpoints.
 */

const KEYS = {
  apiKey: 'ai.geminiApiKey',
  model: 'ai.model',
  enabled: 'ai.enabled',
  dailySummary: 'ai.dailySummary',
} as const

export const AI_MODELS = [
  { value: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash — fast, free tier' },
  { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash — fast, cheap' },
  { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro — slower, better reasoning' },
]

export const DEFAULT_MODEL = 'gemini-2.0-flash-exp'

export interface AiConfig {
  apiKey: string | null
  model: string
  enabled: boolean
  dailySummary: boolean
  /** Where the key came from, so Settings can explain itself honestly. */
  source: 'settings' | 'environment' | 'none'
}

const TTL_MS = 20_000
let cache: { value: AiConfig; expiresAt: number } | null = null

/** The .env template ships placeholders like "your-gemini-api-key"; those are not keys. */
function realKey(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('your-')) return null
  return trimmed
}

export async function getAiConfig(force = false): Promise<AiConfig> {
  if (!force && cache && cache.expiresAt > Date.now()) return cache.value

  const rows = await prisma.appSetting.findMany({
    where: { key: { in: Object.values(KEYS) } },
  })
  const saved = new Map(rows.map((r) => [r.key, r.value]))

  const stored = realKey(saved.get(KEYS.apiKey) as string | undefined)
  const fromEnv = realKey(process.env.GEMINI_API_KEY)

  const value: AiConfig = {
    apiKey: stored ?? fromEnv,
    model: (saved.get(KEYS.model) as string) || process.env.GEMINI_MODEL || DEFAULT_MODEL,
    // The assistant is on by default once a key exists; nobody sets a key and
    // then expects to have to switch it on as well.
    enabled: saved.get(KEYS.enabled) !== false,
    dailySummary: saved.get(KEYS.dailySummary) === true,
    source: stored ? 'settings' : fromEnv ? 'environment' : 'none',
  }

  cache = { value, expiresAt: Date.now() + TTL_MS }
  return value
}

export function invalidateAiConfig(): void {
  cache = null
}

export async function saveAiConfig(
  companyId: string,
  patch: { apiKey?: string | null; model?: string; enabled?: boolean; dailySummary?: boolean },
): Promise<void> {
  const writes: Array<[string, unknown]> = []

  if (patch.apiKey !== undefined) writes.push([KEYS.apiKey, patch.apiKey])
  if (patch.model !== undefined) writes.push([KEYS.model, patch.model])
  if (patch.enabled !== undefined) writes.push([KEYS.enabled, patch.enabled])
  if (patch.dailySummary !== undefined) writes.push([KEYS.dailySummary, patch.dailySummary])

  for (const [key, value] of writes) {
    await prisma.appSetting.upsert({
      where: { companyId_key: { companyId, key } },
      update: { value: value as never },
      create: { companyId, key, value: value as never },
    })
  }

  invalidateAiConfig()
}

/** Last four characters only, so Settings can show that *a* key is saved. */
export function maskKey(key: string | null): string | null {
  if (!key) return null
  return key.length <= 4 ? '••••' : `••••••••${key.slice(-4)}`
}
