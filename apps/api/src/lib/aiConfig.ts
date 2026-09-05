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
 *
 * Two providers are supported. Which one is in use is a setting, not a rewrite:
 * a key that stops working, a price change or a model that starts refusing
 * should never mean editing code, and a mill that has an OpenAI account should
 * not be told to go and open a Google one.
 */

export type AiProvider = 'openai' | 'gemini'

const KEYS = {
  provider: 'ai.provider',
  openaiApiKey: 'ai.openaiApiKey',
  geminiApiKey: 'ai.geminiApiKey',
  model: 'ai.model',
  enabled: 'ai.enabled',
  dailySummary: 'ai.dailySummary',
} as const

export interface ModelOption {
  value: string
  label: string
  provider: AiProvider
}

/**
 * The models offered in Settings.
 *
 * Deliberately short. A list of forty model names is not a choice, it is a
 * quiz — and every extra row is one more thing that can be picked wrongly and
 * then blamed on the ERP.
 */
export const AI_MODELS: ModelOption[] = [
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini — fast and cheap (recommended)', provider: 'openai' },
  { value: 'gpt-5.4', label: 'GPT-5.4 — better reasoning, costs more', provider: 'openai' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini — older, cheapest', provider: 'openai' },
  { value: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash — fast, free tier', provider: 'gemini' },
  { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash — fast, cheap', provider: 'gemini' },
  { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro — slower, better reasoning', provider: 'gemini' },
]

export const DEFAULT_MODEL: Record<AiProvider, string> = {
  openai: 'gpt-5.4-mini',
  gemini: 'gemini-2.0-flash-exp',
}

export const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  gemini: 'Google Gemini',
}

export interface AiConfig {
  provider: AiProvider
  apiKey: string | null
  model: string
  enabled: boolean
  dailySummary: boolean
  /** Where the key came from, so Settings can explain itself honestly. */
  source: 'settings' | 'environment' | 'none'
  /** Which providers have a usable key at all, for the Settings screen. */
  available: AiProvider[]
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

/**
 * OPENAI_API_KEY is the name every example uses; OPEN_AI_API_KEY is the name
 * people actually type. Accepting both costs one line and saves an hour of
 * "the key is right there and it still says not configured".
 */
function openAiKeyFromEnv(): string | null {
  return realKey(process.env.OPENAI_API_KEY) ?? realKey(process.env.OPEN_AI_API_KEY)
}

export async function getAiConfig(force = false): Promise<AiConfig> {
  if (!force && cache && cache.expiresAt > Date.now()) return cache.value

  const rows = await prisma.appSetting.findMany({
    where: { key: { in: Object.values(KEYS) } },
  })
  const saved = new Map(rows.map((r) => [r.key, r.value]))

  const keys: Record<AiProvider, { stored: string | null; env: string | null }> = {
    openai: {
      stored: realKey(saved.get(KEYS.openaiApiKey) as string | undefined),
      env: openAiKeyFromEnv(),
    },
    gemini: {
      stored: realKey(saved.get(KEYS.geminiApiKey) as string | undefined),
      env: realKey(process.env.GEMINI_API_KEY),
    },
  }

  const available = (['openai', 'gemini'] as AiProvider[]).filter(
    (p) => keys[p].stored ?? keys[p].env,
  )

  // A saved choice wins. Otherwise take whichever provider actually has a key,
  // preferring OpenAI — so dropping a key into .env is enough to switch on the
  // assistant with nothing else to configure.
  const chosen = saved.get(KEYS.provider) as AiProvider | undefined
  const provider: AiProvider =
    chosen && available.includes(chosen) ? chosen : (available[0] ?? 'openai')

  const { stored, env } = keys[provider]
  const savedModel = saved.get(KEYS.model) as string | undefined
  const modelBelongsToProvider = AI_MODELS.some(
    (m) => m.value === savedModel && m.provider === provider,
  )

  const value: AiConfig = {
    provider,
    apiKey: stored ?? env,
    // Switching provider must not leave a Gemini model name pointed at OpenAI.
    model: modelBelongsToProvider ? savedModel! : DEFAULT_MODEL[provider],
    // The assistant is on by default once a key exists; nobody sets a key and
    // then expects to have to switch it on as well.
    enabled: saved.get(KEYS.enabled) !== false,
    dailySummary: saved.get(KEYS.dailySummary) === true,
    source: stored ? 'settings' : env ? 'environment' : 'none',
    available,
  }

  cache = { value, expiresAt: Date.now() + TTL_MS }
  return value
}

export function invalidateAiConfig(): void {
  cache = null
}

export async function saveAiConfig(
  companyId: string,
  patch: {
    provider?: AiProvider
    apiKey?: string | null
    model?: string
    enabled?: boolean
    dailySummary?: boolean
  },
): Promise<void> {
  const writes: Array<[string, unknown]> = []

  if (patch.provider !== undefined) writes.push([KEYS.provider, patch.provider])
  if (patch.model !== undefined) writes.push([KEYS.model, patch.model])
  if (patch.enabled !== undefined) writes.push([KEYS.enabled, patch.enabled])
  if (patch.dailySummary !== undefined) writes.push([KEYS.dailySummary, patch.dailySummary])

  // A key belongs to one provider. Saving it against whichever provider is
  // being configured means switching back and forth does not lose the other
  // one, and an OpenAI key can never end up being sent to Google.
  if (patch.apiKey !== undefined) {
    const target = patch.provider ?? (await getAiConfig()).provider
    writes.push([target === 'openai' ? KEYS.openaiApiKey : KEYS.geminiApiKey, patch.apiKey])
  }

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
