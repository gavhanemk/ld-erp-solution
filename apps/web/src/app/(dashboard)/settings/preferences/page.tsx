'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError } from '@/lib/api'
import { loadAppSettings } from '@/lib/appSettings'
import { settingsApi, type PreferenceDefinition } from '@/lib/settingsApi'
import { Boxes, Factory, FileCheck2, LayoutList, MonitorSmartphone, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { LoadingRow, Notice, SaveBar, SettingsCard, Toggle } from '@/components/settings/ui'
import { SmartSelect } from '@/components/ui/SmartSelect'

/** Each group of preferences under the icon of the part of the ERP it changes. */
const GROUP_ICON: Record<string, LucideIcon> = {
  'Lists and screens': LayoutList,
  Stock: Boxes,
  Production: Factory,
  Approvals: FileCheck2,
}

/**
 * Preferences.
 *
 * Everything on this screen changes something. The list is short on purpose:
 * a preference is added here when the part of the ERP that reads it is built,
 * not before, so nothing on this page is a switch that does nothing.
 */
export default function PreferencesPage() {
  const [definitions, setDefinitions] = useState<PreferenceDefinition[]>([])
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [saved, setSaved] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await settingsApi.preferences.get()
      setDefinitions(res.definitions)
      setValues(res.data)
      setSaved(res.data)
    } catch (err) {
      setMessage({
        kind: 'error',
        text:
          err instanceof ApiError
            ? err.status === 403
              ? 'Your role does not allow changing preferences. Ask an administrator.'
              : err.message
            : 'Could not load preferences.',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo(() => {
    const map = new Map<string, PreferenceDefinition[]>()
    for (const def of definitions) {
      const list = map.get(def.group) ?? []
      list.push(def)
      map.set(def.group, list)
    }
    return [...map.entries()]
  }, [definitions])

  const dirty = useMemo(
    () => definitions.some((d) => String(values[d.key]) !== String(saved[d.key])),
    [definitions, values, saved],
  )

  const set = (key: string, value: unknown) => {
    setValues((v) => ({ ...v, [key]: value }))
    setErrors((e) => (e[key] ? { ...e, [key]: '' } : e))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    setMessage(null)

    // Only what actually changed is sent, so a save never rewrites settings
    // somebody else adjusted while this page was open.
    const patch: Record<string, unknown> = {}
    for (const def of definitions) {
      if (String(values[def.key]) === String(saved[def.key])) continue
      patch[def.key] = def.type === 'number' ? Number(values[def.key]) : values[def.key]
    }

    if (Object.keys(patch).length === 0) {
      setSaving(false)
      return
    }

    try {
      const res = await settingsApi.preferences.update(patch)
      setValues(res.data)
      setSaved(res.data)
      // Rows per page and the date format are read all over the app, so the
      // shared copy is refreshed rather than waiting for the next reload.
      await loadAppSettings(true)
      setMessage({ kind: 'success', text: 'Preferences saved.' })
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fieldErrors) setErrors(err.fieldErrors)
        setMessage({
          kind: 'error',
          text: err.fieldErrors ? 'Please correct the highlighted settings.' : err.message,
        })
      } else {
        setMessage({ kind: 'error', text: 'Could not save. Is the API running?' })
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <SettingsCard title="Preferences" icon={SlidersHorizontal}>
        <LoadingRow />
      </SettingsCard>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      {groups.map(([group, defs]) => (
        <SettingsCard key={group} title={group} icon={GROUP_ICON[group] ?? SlidersHorizontal}>
          <div className="divide-y divide-border/60">
            {defs.map((def) => (
              <div
                key={def.key}
                className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{def.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{def.help}</p>
                  <p className="text-muted-foreground mt-2 inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-[11px]">
                    <MonitorSmartphone size={11} /> {def.affects}
                  </p>
                  {errors[def.key] && (
                    <p className="text-xs text-red-500 mt-1">{errors[def.key]}</p>
                  )}
                </div>

                <div className="shrink-0 pt-0.5">
                  {def.type === 'boolean' && (
                    <Toggle
                      checked={Boolean(values[def.key])}
                      onChange={(v) => set(def.key, v)}
                      label={def.label}
                    />
                  )}

                  {def.type === 'select' && (
                    <SmartSelect
                      className="form-input w-44"
                      value={String(values[def.key] ?? '')}
                      onChange={(e) => set(def.key, e.target.value)}
                      aria-label={def.label}
                    >
                      {def.options?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </SmartSelect>
                  )}

                  {def.type === 'number' && (
                    <input
                      type="number"
                      className="form-input w-28 text-right"
                      min={def.min}
                      max={def.max}
                      value={String(values[def.key] ?? '')}
                      onChange={(e) => set(def.key, e.target.value)}
                      aria-label={def.label}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </SettingsCard>
      ))}

      <p className="text-xs text-muted-foreground max-w-2xl">
        More preferences appear here as the screens that use them are built. A setting is only
        added once it changes something, so nothing on this page is decoration.
      </p>

      <SaveBar
        saving={saving}
        disabled={!dirty}
        note={dirty ? 'You have changes that are not saved yet.' : 'Everything here is saved.'}
      />
    </form>
  )
}
