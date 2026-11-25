'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Crown, Loader2, Search, ShieldCheck } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { settingsApi, type PermissionModule, type SettingsRole } from '@/lib/settingsApi'
import { FormFrame } from '@/components/ui/FormFrame'
import { Field } from './ui'
import { cn } from '@/lib/utils'

/**
 * The access matrix for one role: every module, every screen in it, and a
 * switch for each thing that can be done there.
 *
 * Modules down the side, each opening to its screens; the actions across the
 * top. A module's own row switches a column for all its screens at once, and
 * the tick at the start of a row switches the whole row. A screen only shows
 * the switches that mean something on it — a report has nothing to approve.
 *
 * Two rules keep a role coherent: switching anything on for a screen switches
 * on View too (you cannot add to a screen you cannot open), and switching
 * View off switches off the rest.
 *
 * Super Admin is shown, not edited: it holds everything, always.
 */
export function RoleEditor({
  open,
  role,
  modules,
  actions,
  onClose,
  onSaved,
}: {
  open: boolean
  /** Null when creating a new role. */
  role: SettingsRole | null
  modules: PermissionModule[]
  actions: { action: string; label: string }[]
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [granted, setGranted] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [shut, setShut] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(role?.name ?? '')
    setDescription(role?.description ?? '')
    setGranted(new Set(role?.permissions ?? []))
    setSearch('')
    setShut(new Set())
    setErrors({})
    setFormError(null)
  }, [open, role])

  const readOnly = Boolean(role?.unrestricted)
  const isOn = (key: string) => readOnly || granted.has(key)

  const allKeys = useMemo(
    () => modules.flatMap((m) => m.screens.flatMap((s) => s.actions.map((a) => a.key))),
    [modules],
  )
  const onCount = readOnly ? allKeys.length : allKeys.filter((k) => granted.has(k)).length

  const term = search.trim().toLowerCase()
  const shown = useMemo(
    () =>
      modules
        .map((m) => {
          if (!term || m.label.toLowerCase().includes(term)) return m
          const screens = m.screens.filter(
            (s) => s.label.toLowerCase().includes(term) || (s.hint ?? '').toLowerCase().includes(term),
          )
          return screens.length ? { ...m, screens } : null
        })
        .filter((m): m is PermissionModule => m !== null),
    [modules, term],
  )

  if (!open) return null

  /** Switches keys on or off, keeping each screen's View in step with the rest. */
  const set = (keys: string[], on: boolean) => {
    if (readOnly) return
    setGranted((prev) => {
      const next = new Set(prev)
      for (const k of keys) {
        const [screen, action] = k.split(':')
        if (on) {
          next.add(k)
          if (action !== 'view') next.add(`${screen}:view`)
        } else {
          next.delete(k)
          // No View, nothing else: every switch on the screen goes off.
          if (action === 'view') for (const g of [...next]) if (g.startsWith(`${screen}:`)) next.delete(g)
        }
      }
      return next
    })
  }

  const state = (keys: string[]): 'on' | 'off' | 'some' => {
    if (!keys.length) return 'off'
    const n = keys.filter(isOn).length
    return n === 0 ? 'off' : n === keys.length ? 'on' : 'some'
  }

  const submit = async () => {
    setSaving(true)
    setErrors({})
    setFormError(null)
    const payload: Record<string, unknown> = { name: name.trim(), description: description.trim() || null }
    // Super Admin always has everything; the server refuses an attempt to narrow it.
    if (!readOnly) payload.permissions = [...granted]
    try {
      if (role) {
        const res = await settingsApi.roles.update(role.id, payload)
        onSaved(res.message ?? `${payload.name} updated.`)
      } else {
        await settingsApi.roles.create(payload)
        onSaved(`Role "${payload.name}" created. Give it to people from the People list.`)
      }
      onClose()
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fieldErrors) setErrors(err.fieldErrors)
        setFormError(err.fieldErrors ? 'Please correct the highlighted fields.' : err.message)
      } else {
        setFormError('Could not save the role.')
      }
    } finally {
      setSaving(false)
    }
  }

  const primary = readOnly ? (
    <button type="button" className="btn-secondary" onClick={onClose}>
      Close
    </button>
  ) : (
    <button type="button" className="btn-primary" onClick={() => void submit()} disabled={saving || !name.trim()}>
      {saving && <Loader2 size={15} className="animate-spin" />}
      {role ? 'Save role' : 'Create role'}
    </button>
  )

  return (
    <FormFrame
      icon={readOnly ? Crown : ShieldCheck}
      title={role ? `Permissions: ${role.name}` : 'New role'}
      subtitle={
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">
          Security access matrix{readOnly ? ' · every screen, always' : ''}
        </span>
      }
      primary={primary}
      footer={
        !readOnly && (
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        )
      }
      footerNote={
        readOnly
          ? 'Only a Super Admin can give someone the Super Admin role.'
          : `${onCount} of ${allKeys.length} switched on · applies to everyone on this role as soon as it is saved`
      }
      error={formError}
      onClose={onClose}
      busy={saving}
      width="max-w-7xl"
    >
      {!readOnly && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Role name" htmlFor="role-name" required error={errors.name}>
            <input
              id="role-name"
              className="form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={Boolean(role?.isSystem)}
              placeholder="Store Keeper"
            />
          </Field>
          <Field label="What it is for" htmlFor="role-desc" error={errors.description} span={2}>
            <input
              id="role-desc"
              className="form-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Receives goods and issues material; cannot approve"
            />
          </Field>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="border-border bg-secondary/50 focus-within:border-primary focus-within:ring-primary/20 flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl border px-4 focus-within:ring-2">
          <Search size={16} className="text-muted-foreground" />
          <input
            className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
            placeholder="Search modules or screens…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search modules or screens"
          />
        </div>
        {!readOnly && (
          <>
            <button type="button" className="btn-secondary h-9 text-xs" onClick={() => set(allKeys, true)}>
              Allow everything
            </button>
            <button type="button" className="btn-ghost h-9 text-xs" onClick={() => setGranted(new Set())}>
              Clear everything
            </button>
          </>
        )}
        <button
          type="button"
          className="btn-ghost ml-auto h-9 text-xs"
          onClick={() => setShut((s) => (s.size ? new Set() : new Set(modules.map((m) => m.module))))}
        >
          {shut.size ? 'Open all modules' : 'Fold all modules'}
        </button>
      </div>

      <div className="border-border overflow-hidden rounded-xl border">
        <div className="max-h-[56vh] overflow-auto">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead className="bg-secondary sticky top-0 z-10">
              <tr className="border-border border-b">
                <th className="text-muted-foreground px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider">
                  Module / screen
                </th>
                {actions.map((a) => (
                  <th
                    key={a.action}
                    className="text-muted-foreground w-20 px-2 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider"
                  >
                    {a.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={actions.length + 1} className="text-muted-foreground px-4 py-8 text-center text-sm">
                    Nothing matches that search.
                  </td>
                </tr>
              )}
              {shown.map((m) => (
                <ModuleRows
                  key={m.module}
                  module={m}
                  actions={actions}
                  folded={shut.has(m.module) && !term}
                  readOnly={readOnly}
                  isOn={isOn}
                  state={state}
                  set={set}
                  onFold={() =>
                    setShut((prev) => {
                      const next = new Set(prev)
                      if (next.has(m.module)) next.delete(m.module)
                      else next.add(m.module)
                      return next
                    })
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="border-border flex items-start gap-3 rounded-xl border p-4">
        <span className="border-border bg-secondary flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
          <AlertCircle size={17} className="text-foreground" />
        </span>
        <div className="min-w-0">
          <p className="text-foreground text-sm font-semibold">Access change notice</p>
          <p className="text-muted-foreground mt-0.5 text-xs leading-snug">
            {readOnly
              ? 'Super Admin always has every screen and every action. Only a Super Admin can give someone this role.'
              : 'Changes apply to everyone on this role as soon as they are saved — people already signed in are checked again on their next click. View decides which screens appear in their menu; every other switch is enforced by the server.'}
          </p>
        </div>
      </div>
    </FormFrame>
  )
}

/** A module's own row, then its screens'. A module of one screen is a single row. */
function ModuleRows({
  module: m,
  actions,
  folded,
  readOnly,
  isOn,
  state,
  set,
  onFold,
}: {
  module: PermissionModule
  actions: { action: string; label: string }[]
  folded: boolean
  readOnly: boolean
  isOn: (key: string) => boolean
  state: (keys: string[]) => 'on' | 'off' | 'some'
  set: (keys: string[], on: boolean) => void
  onFold: () => void
}) {
  const single = m.screens.length === 1 && m.screens[0].key === m.module
  const moduleKeys = m.screens.flatMap((s) => s.actions.map((a) => a.key))
  const columnKeys = (action: string) =>
    m.screens.flatMap((s) => s.actions.filter((a) => a.action === action).map((a) => a.key))
  const onCount = moduleKeys.filter(isOn).length

  return (
    <>
      <tr className="border-border border-b">
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <Tick
              state={state(moduleKeys)}
              disabled={readOnly}
              label={`Everything in ${m.label}`}
              onChange={(on) => set(moduleKeys, on)}
            />
            {single ? (
              <span className="text-foreground font-semibold">{m.screens[0].label}</span>
            ) : (
              <button type="button" onClick={onFold} className="hover:text-primary flex min-w-0 items-center gap-1.5 text-left">
                {folded ? (
                  <ChevronRight size={14} className="text-muted-foreground" />
                ) : (
                  <ChevronDown size={14} className="text-muted-foreground" />
                )}
                <span className="text-foreground font-semibold">{m.label}</span>
              </button>
            )}
            <span className="text-muted-foreground text-[11px] tabular-nums">
              {onCount}/{moduleKeys.length}
            </span>
          </div>
          {single && m.screens[0].hint && (
            <p className="text-muted-foreground ml-7 mt-0.5 text-[11px] leading-tight">{m.screens[0].hint}</p>
          )}
        </td>
        {actions.map((a) => {
          const keys = columnKeys(a.action)
          return (
            <td key={a.action} className="px-2 py-2.5 text-center">
              {keys.length > 0 && (
                <Switch
                  state={state(keys)}
                  disabled={readOnly}
                  label={single ? `${a.label} on ${m.screens[0].label}` : `${a.label} on every ${m.label} screen`}
                  onChange={(on) => set(keys, on)}
                />
              )}
            </td>
          )
        })}
      </tr>
      {!single &&
        !folded &&
        m.screens.map((s) => {
          const rowKeys = s.actions.map((a) => a.key)
          return (
            <tr key={s.key} className="border-border/60 hover:bg-secondary/30 border-b">
              <td className="py-2 pl-11 pr-4">
                <div className="flex items-center gap-2.5">
                  <Tick
                    state={state(rowKeys)}
                    disabled={readOnly}
                    label={`Everything on ${s.label}`}
                    onChange={(on) => set(rowKeys, on)}
                  />
                  <div className="min-w-0">
                    <p className="text-muted-foreground font-medium">{s.label}</p>
                    {s.hint && <p className="text-muted-foreground text-[11px] leading-tight">{s.hint}</p>}
                  </div>
                </div>
              </td>
              {actions.map((a) => {
                const item = s.actions.find((x) => x.action === a.action)
                return (
                  <td key={a.action} className="px-2 py-2 text-center">
                    {item && (
                      <Switch
                        state={isOn(item.key) ? 'on' : 'off'}
                        disabled={readOnly}
                        label={`${item.label} on ${s.label}`}
                        onChange={(on) => set([item.key], on)}
                      />
                    )}
                  </td>
                )
              })}
            </tr>
          )
        })}
    </>
  )
}

/** The switch in a cell: on, off, or partly on for a module's column. */
function Switch({
  state,
  disabled,
  label,
  onChange,
}: {
  state: 'on' | 'off' | 'some'
  disabled?: boolean
  label: string
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={state === 'on' ? 'true' : state === 'some' ? 'mixed' : 'false'}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(state !== 'on')}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-default',
        state === 'on' ? 'bg-emerald-500' : state === 'some' ? 'bg-emerald-500/45' : 'bg-slate-300',
      )}
    >
      <span
        className={cn(
          'absolute left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
          state === 'on' && 'translate-x-4',
          state === 'some' && 'translate-x-2',
        )}
      />
    </button>
  )
}

/** The tick at the start of a row: the whole row on, off, or partly. */
function Tick({
  state,
  disabled,
  label,
  onChange,
}: {
  state: 'on' | 'off' | 'some'
  disabled?: boolean
  label: string
  onChange: (on: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      title={label}
      disabled={disabled}
      checked={state === 'on'}
      ref={(el) => {
        if (el) el.indeterminate = state === 'some'
      }}
      onChange={() => onChange(state !== 'on')}
      className="h-4 w-4 shrink-0 cursor-pointer rounded accent-emerald-500 disabled:cursor-default"
    />
  )
}
