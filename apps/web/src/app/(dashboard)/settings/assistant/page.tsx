'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, ShieldCheck, ExternalLink, Zap, CheckCircle2, XCircle } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { settingsApi, type AiSettings } from '@/lib/settingsApi'
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
      const res = await settingsApi.ai.test(apiKey.trim() || undefined)
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
        description="The assistant runs on Google Gemini. It needs a key from your own Google account, so the usage and the bill are yours."
      >
        <div className="space-y-5">
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
              help="Get one free at aistudio.google.com — sign in, then 'Get API key'. Leave blank to keep the saved one."
            >
              <div className="flex gap-2">
                <input
                  id="ai-key"
                  type="password"
                  autoComplete="off"
                  className="form-input font-mono flex-1"
                  placeholder="AIza..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-secondary whitespace-nowrap"
                  onClick={() => void test()}
                  disabled={testing || (!apiKey.trim() && !settings?.configured)}
                >
                  {testing ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
                  Test
                </button>
              </div>
            </Field>

            <Field label="Model" htmlFor="ai-model" help="Flash is fast and cheap; Pro reasons better">
              <select
                id="ai-model"
                className="form-input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {settings?.models.map((m) => (
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
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1"
            >
              Open Google AI Studio to get a key <ExternalLink size={11} />
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
          Gemini has a free tier that is generous enough for a mill this size. You are billed by
          Google directly, and nothing here sends your data anywhere else.
        </p>
        <SaveButton saving={saving} />
      </div>
    </form>
  )
}
