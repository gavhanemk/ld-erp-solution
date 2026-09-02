'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, ShieldCheck, ExternalLink, Zap, CheckCircle2, XCircle } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { settingsApi, type AiProvider, type AiSettings } from '@/lib/settingsApi'
import { Field, LoadingRow, Notice, SaveButton, SettingsCard, Toggle } from '@/components/settings/ui'

/**
 * The assistant.
 *
 * Absolute has nothing like this, so there was nothing to copy. The design
 * choices worth noting: the key is set here rather than in a file on the
 * server, "Test" actually asks the model a question instead of checking a
 * string is present, and the assistant is limited by the asking person's own
 * permissions rather than by a switch on this page.
 */
export default function AssistantSettingsPage() {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const [provider, setProvider] = useState<AiProvider>('openai')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [dailySummary, setDailySummary] = useState(false)

  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(
    null,
  )
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await settingsApi.ai.get()
      setSettings(res.data)
      setProvider(res.data.provider)
      setModel(res.data.model)
      setEnabled(res.data.enabled)
      setDailySummary(res.data.dailySummary)
    } catch (err) {
      setMessage({
        kind: 'error',
        text:
          err instanceof ApiError
            ? err.status === 403
              ? 'Your role does not allow changing the assistant. Ask an administrator.'
              : err.message
            : 'Could not load the assistant settings.',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    setTestResult(null)

    try {
      const res = await settingsApi.ai.update({
        provider,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        model,
        enabled,
        dailySummary,
      })
      setSettings((s) => (s ? { ...s, ...res.data } : s))
      setApiKey('')
      setMessage({ kind: 'success', text: 'Saved.' })
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not save.',
      })
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await settingsApi.ai.test()
      setTestResult({ ok: res.success, text: res.message })
    } catch (err) {
      setTestResult({
        ok: false,
        text: err instanceof ApiError ? err.message : 'Could not reach the server.',
      })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <SettingsCard title="Assistant">
        <LoadingRow />
      </SettingsCard>
    )
  }

  const clearKey = async () => {
    if (!confirm('Remove the saved API key? The assistant will stop answering.')) return
    setSaving(true)
    try {
      const res = await settingsApi.ai.update({ apiKey: '' })
      setSettings((s) => (s ? { ...s, ...res.data } : s))
      setMessage({ kind: 'info', text: 'Key removed. The assistant is no longer connected.' })
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      <SettingsCard
        title="Connection"
        description="The assistant needs a key from your own account with whichever company you choose. The usage and the bill are yours, and nothing goes anywhere else."
      >
        <div className="space-y-5">
          {/* Two providers, and the choice is real: a key that stops working,
              a price change, or a model that starts refusing should never mean
              waiting for a developer. */}
          <div className="grid grid-cols-2 gap-3">
            {(['openai', 'gemini'] as AiProvider[]).map((p) => {
              const chosen = provider === p
              const hasKey = settings?.available.includes(p)
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setProvider(p)
                    // A Gemini model name pointed at OpenAI is a broken
                    // assistant that still looks configured, so the model
                    // moves with the provider.
                    const first = settings?.models.find((m) => m.provider === p)
                    if (first) setModel(first.value)
                  }}
                  className={`text-left p-3 rounded-lg border transition-colors ${
                    chosen
                      ? 'border-teal-500/60 bg-teal-500/10'
                      : 'border-border bg-secondary/30 hover:border-border/80'
                  }`}
                >
                  <p className="text-sm font-medium text-foreground">
                    {p === 'openai' ? 'OpenAI' : 'Google Gemini'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {p === 'openai'
                      ? 'Paid per question. Pennies a day at this size.'
                      : 'Has a free tier, with daily limits.'}
                  </p>
                  {hasKey && (
                    <p className="text-[11px] text-emerald-400 mt-1">a key is saved</p>
                  )}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-secondary/30">
            {settings?.configured ? (
              <CheckCircle2 size={18} className="text-emerald-400 shrink-0" />
            ) : (
              <XCircle size={18} className="text-muted-foreground shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                {settings?.configured ? 'A key is saved' : 'No key yet — the assistant cannot answer'}
              </p>
              <p className="text-xs text-muted-foreground">
                {settings?.configured
                  ? `${settings.keyHint} · ${
                      settings.source === 'environment'
                        ? 'set in the server configuration file'
                        : 'set here in Settings'
                    }`
                  : 'Paste one below, then press Test.'}
              </p>
            </div>
            {settings?.configured && settings.source === 'settings' && (
              <button
                type="button"
                onClick={() => void clearKey()}
                className="btn-ghost text-xs text-muted-foreground hover:text-red-400"
                disabled={saving}
              >
                Remove
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field
              label={settings?.configured ? 'Replace the key' : 'API key'}
              htmlFor="ai-key"
              span={2}
              help={
                provider === 'openai'
                  ? 'From platform.openai.com → API keys. Leave blank to keep the saved one.'
                  : "From aistudio.google.com — sign in, then 'Get API key'. Leave blank to keep the saved one."
              }
            >
              <div className="flex gap-2">
                <input
                  id="ai-key"
                  type="password"
                  autoComplete="off"
                  className="form-input font-mono flex-1"
                  placeholder={provider === 'openai' ? 'sk-...' : 'AIza...'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-secondary whitespace-nowrap"
                  onClick={() => void test()}
                  disabled={testing || !settings?.configured}
                  title={
                    settings?.configured
                      ? 'Asks the model a real question'
                      : 'Save a key first, then test it'
                  }
                >
                  {testing ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
                  Test
                </button>
              </div>
            </Field>

            <Field
              label="Model"
              htmlFor="ai-model"
              help="The smaller model is fast and cheap and answers these questions perfectly well."
            >
              <select
                id="ai-model"
                className="form-input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {settings?.models
                  .filter((m) => m.provider === provider)
                  .map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
              </select>
            </Field>
          </div>

          {testResult && (
            <Notice kind={testResult.ok ? 'success' : 'error'}>{testResult.text}</Notice>
          )}

          <p className="text-xs text-muted-foreground">
            <a
              href={
                provider === 'openai'
                  ? 'https://platform.openai.com/api-keys'
                  : 'https://aistudio.google.com/app/apikey'
              }
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1"
            >
              {provider === 'openai'
                ? 'Open the OpenAI dashboard to get a key'
                : 'Open Google AI Studio to get a key'}{' '}
              <ExternalLink size={11} />
            </a>
          </p>
        </div>
      </SettingsCard>

      <SettingsCard title="What the assistant may do">
        <div className="divide-y divide-border/60">
          <div className="flex items-start justify-between gap-6 py-4 first:pt-0">
            <div>
              <p className="text-sm font-medium text-foreground">Assistant switched on</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Turn off to stop it answering without removing the key.
              </p>
            </div>
            <Toggle checked={enabled} onChange={setEnabled} label="Assistant switched on" />
          </div>

          <div className="flex items-start justify-between gap-6 py-4">
            <div>
              <p className="text-sm font-medium text-foreground">Daily summary</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                A short round-up of production, orders and money each evening.
              </p>
              <p className="text-[11px] text-muted-foreground/70 mt-1">
                Written to your notifications. WhatsApp delivery once that is connected.
              </p>
            </div>
            <Toggle checked={dailySummary} onChange={setDailySummary} label="Daily summary" />
          </div>
        </div>

        <div className="mt-5 flex items-start gap-3 p-3 rounded-lg border border-teal-500/30 bg-teal-500/5">
          <ShieldCheck size={16} className="text-teal-400 mt-0.5 shrink-0" />
          <div className="text-sm text-teal-300">
            <p className="font-medium">The assistant sees only what the person asking can see.</p>
            <p className="text-xs text-teal-300/80 mt-1">
              It runs under their role, not its own. A cutting supervisor asking what customers owe
              is told their role has no access to accounts — the same answer they would get by
              clicking. This is enforced on the server, not offered as a setting, so it cannot be
              switched off by mistake.
            </p>
          </div>
        </div>
      </SettingsCard>

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground max-w-xl">
          {provider === 'openai'
            ? 'OpenAI charges per question — a few paise each, so a busy day costs less than a cup of chai. You are billed by OpenAI directly.'
            : 'Gemini has a free tier that is generous enough for a mill this size, with daily limits. You are billed by Google directly.'}{' '}
          Only the figures needed to answer the question are sent, and nothing is used to train
          anybody&rsquo;s model.
        </p>
        <SaveButton saving={saving} />
      </div>
    </form>
  )
}
