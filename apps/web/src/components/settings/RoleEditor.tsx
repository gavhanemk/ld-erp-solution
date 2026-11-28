'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen, Bot, Check, Crown, Factory, Info, Layers, LayoutDashboard, Loader2, Minus, Package, Search,
  Settings, ShieldCheck, ShoppingCart, Tag, Users, Warehouse, Wrench, type LucideIcon,
} from 'lucide-react'
import { ApiError } from '@/lib/api'
import { settingsApi, type PermissionModule, type SettingsRole } from '@/lib/settingsApi'
import { FormFrame } from '@/components/ui/FormFrame'
import { Field } from './ui'
import { cn } from '@/lib/utils'

/**
 * The access matrix for one role, module by module.
 *
 * The modules down the left, each with how much of it is switched on; the
 * chosen module's screens on the right, with a switch for each thing that
 * can be done there. It used to be one table of seventy-odd rows, every row
 * the same weight, which read as a wall: now a module is a click away and
 * its screens fit on the screen. Only the columns a module uses are shown,
 * and each column heading carries the switch for all its screens at once.
 *
 * Two rules keep a role coherent: switching anything on for a screen switches
 * on View too (you cannot add to a screen you cannot open), and switching
 * View off switches off the rest.
 *
 * Super Admin is shown, not edited: it holds everything, always.
 */

const MODULE_ICON: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  masters: Layers,
  sales: ShoppingCart,
  purchase: Package,
  inventory: Warehouse,
  production: Factory,
  accounts: BookOpen,
  hr: Users,
  vhagar: Tag,
  maintenance: Wrench,
  ai: Bot,
  settings: Settings,
  admin: ShieldCheck,
}

type Tri = 'on' | 'off' | 'some'

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
  const [current, setCurrent] = useState('')
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(role?.name ?? '')
    setDescription(role?.description ?? '')
    setGranted(new Set(role?.permissions ?? []))
    setSearch('')
    setCurrent(modules[0]?.module ?? '')
    setErrors({})
    setFormError(null)
  }, [open, role, modules])

  const readOnly = Boolean(role?.unrestricted)
  const isOn = (key: string) => readOnly || granted.has(key)

  const keysOf = (m: PermissionModule) => m.screens.flatMap((s) => s.actions.map((a) => a.key))
  const allKeys = useMemo(() => modules.flatMap(keysOf), [modules])
  const onCount = readOnly ? allKeys.length : allKeys.filter((k) => granted.has(k)).length
  const screensOpen = readOnly
    ? modules.reduce((n, m) => n + m.screens.length, 0)
    : new Set([...granted].filter((k) => k.endsWith(':view')).map((k) => k.split(':')[0])).size
  const totalScreens = modules.reduce((n, m) => n + m.screens.length, 0)

  // What the search leaves: a module whose name matches keeps all its screens.
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
  const active = shown.find((m) => m.module === current) ?? shown[0]

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

  const tri = (keys: string[]): Tri => {
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

  // The columns this module uses, in the catalogue's order.
  const columns = active ? actions.filter((a) => active.screens.some((s) => s.actions.some((x) => x.action === a.action))) : []
  const columnKeys = (action: string) =>
    active ? active.screens.filter((s) => !s.explicit).flatMap((s) => s.actions.filter((a) => a.action === action).map((a) => a.key)) : []
  const ActiveIcon = active ? (MODULE_ICON[active.module] ?? ShieldCheck) : ShieldCheck
  const activeKeys = active ? keysOf(active) : []
  const activeOn = activeKeys.filter(isOn).length
  // What "Allow all" switches: every box but a right given only on purpose.
  const bulkKeys = active ? active.screens.filter((s) => !s.explicit).flatMap((s) => s.actions.map((a) => a.key)) : []

  return (
    <FormFrame
      icon={readOnly ? Crown : ShieldCheck}
      title={role ? `Permissions: ${role.name}` : 'New role'}
      subtitle={
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">
          Security access matrix{readOnly ? ' · every screen, always' : ''}
        </span>
      }
      primary={
        readOnly ? (
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={saving || !name.trim()}>
            {saving && <Loader2 size={15} className="animate-spin" />}
            {role ? 'Save role' : 'Create role'}
          </button>
        )
      }
      footer={
        !readOnly && (
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        )
      }
      footerNote={
        <span className="flex items-center gap-1.5">
          <Info size={13} className="shrink-0" />
          {readOnly
            ? 'Only a Super Admin can give someone the Super Admin role.'
            : 'Applies to everyone on this role as soon as it is saved; people signed in are checked again on their next click.'}
        </span>
      }
      error={formError}
      onClose={onClose}
      busy={saving}
      width="max-w-7xl"
    >
      {/* ── The role, and how much it opens ── */}
      <div className="border-border bg-card grid grid-cols-1 gap-4 rounded-xl border p-4 shadow-sm lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] lg:items-end">
        {readOnly ? (
          <div className="flex items-center gap-3 lg:col-span-2">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-500">
              <Crown size={18} />
            </span>
            <div>
              <p className="text-foreground text-sm font-semibold">Super Admin holds every screen and every action</p>
              <p className="text-muted-foreground text-xs">Nothing here can be switched off. Give people a narrower role for less.</p>
            </div>
          </div>
        ) : (
          <>
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
            <Field label="What it is for" htmlFor="role-desc" error={errors.description}>
              <input
                id="role-desc"
                className="form-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Receives goods and issues material; cannot approve"
              />
            </Field>
          </>
        )}
        <div className="flex items-center gap-4 lg:justify-end">
          <Stat value={`${screensOpen}/${totalScreens}`} label="screens open" />
          <Stat value={`${onCount}/${allKeys.length}`} label="switches on" />
        </div>
      </div>

      {/* ── Search and the whole-role buttons ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="border-border bg-card focus-within:border-primary focus-within:ring-primary/20 flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-xl border px-3.5 shadow-sm focus-within:ring-2">
          <Search size={15} className="text-muted-foreground" />
          <input
            className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
            placeholder="Search modules or screens…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search modules or screens"
          />
        </div>
        {!readOnly && (
          <div className="border-border bg-card flex h-10 items-center rounded-xl border p-1 shadow-sm">
            <button type="button" className="text-foreground hover:bg-secondary rounded-lg px-3 py-1.5 text-xs font-medium" onClick={() => set(allKeys, true)}>
              Allow everything
            </button>
            <span className="bg-border mx-1 h-4 w-px" />
            <button type="button" className="text-muted-foreground hover:bg-secondary hover:text-foreground rounded-lg px-3 py-1.5 text-xs font-medium" onClick={() => setGranted(new Set())}>
              Clear everything
            </button>
          </div>
        )}
      </div>

      {/* ── Modules on the left, the chosen one's screens on the right ── */}
      <div className="grid min-h-0 gap-3 lg:h-[52vh] lg:grid-cols-[17rem_minmax(0,1fr)]">
        <nav aria-label="Modules" className="border-border bg-card no-scrollbar flex gap-1 overflow-auto rounded-xl border p-1.5 shadow-sm lg:flex-col">
          {shown.length === 0 && <p className="text-muted-foreground p-4 text-sm">Nothing matches that search.</p>}
          {shown.map((m) => {
            const Icon = MODULE_ICON[m.module] ?? ShieldCheck
            const keys = keysOf(m)
            const n = keys.filter(isOn).length
            const share = keys.length ? Math.round((n / keys.length) * 100) : 0
            const on = active?.module === m.module
            return (
              <button
                key={m.module}
                type="button"
                onClick={() => setCurrent(m.module)}
                aria-current={on ? 'true' : undefined}
                className={cn(
                  'flex shrink-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors lg:shrink',
                  on ? 'bg-primary/10' : 'hover:bg-secondary',
                )}
              >
                <span
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
                    on ? 'border-primary/30 bg-primary/15 text-primary' : 'border-border bg-secondary/60 text-muted-foreground',
                  )}
                >
                  <Icon size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn('truncate text-sm font-medium', on ? 'text-primary' : 'text-foreground')}>{m.label}</span>
                    <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                      {n}/{keys.length}
                    </span>
                  </span>
                  <span className="bg-secondary mt-1.5 hidden h-1 overflow-hidden rounded-full lg:block">
                    <span
                      className={cn('block h-1 rounded-full', share === 100 ? 'bg-emerald-500' : 'bg-emerald-500/70')}
                      style={{ width: `${share}%` }}
                    />
                  </span>
                </span>
              </button>
            )
          })}
        </nav>

        {active && (
          <section className="border-border bg-card flex min-h-0 flex-col overflow-hidden rounded-xl border shadow-sm">
            <header className="border-border/70 flex flex-wrap items-center gap-3 border-b px-5 py-3.5">
              <span className="bg-primary/10 border-primary/20 text-primary flex h-9 w-9 items-center justify-center rounded-lg border">
                <ActiveIcon size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-foreground text-[15px] font-semibold leading-tight">{active.label}</h3>
                <p className="text-muted-foreground text-xs">
                  {active.screens.length} {active.screens.length === 1 ? 'screen' : 'screens'} · {activeOn} of {activeKeys.length} switched on
                </p>
              </div>
              {!readOnly && (
                <div className="flex items-center gap-1.5">
                  <button type="button" className="btn-secondary h-8 text-xs" onClick={() => set(bulkKeys, true)}>
                    <Check size={13} /> Allow all
                  </button>
                  <button type="button" className="btn-ghost h-8 text-xs" onClick={() => set(activeKeys, false)}>
                    Clear
                  </button>
                </div>
              )}
            </header>

            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[620px] table-fixed border-collapse text-sm">
                <colgroup>
                  <col />
                  {columns.map((c) => (
                    <col key={c.action} className="w-[92px]" />
                  ))}
                </colgroup>
                <thead className="bg-card sticky top-0 z-10">
                  <tr className="border-border/70 border-b">
                    <th className="text-muted-foreground px-5 py-3 text-left align-bottom text-[11px] font-semibold uppercase tracking-wider">
                      Screen
                    </th>
                    {columns.map((c) => {
                      const keys = columnKeys(c.action)
                      return (
                        <th key={c.action} className="px-2 py-3 text-center align-bottom">
                          <span className="text-muted-foreground block text-[11px] font-semibold uppercase tracking-wider">{c.label}</span>
                          <span className="mt-2 flex justify-center">
                            <Switch
                              state={tri(keys)}
                              disabled={readOnly}
                              label={`${c.label} on every ${active.label} screen`}
                              onChange={(on) => set(keys, on)}
                            />
                          </span>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {active.screens.map((s) => {
                    const rowKeys = s.actions.map((a) => a.key)
                    return (
                      <tr key={s.key} className="border-border/50 hover:bg-secondary/40 border-b transition-colors last:border-0">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <Tick state={tri(rowKeys)} disabled={readOnly} label={`Everything on ${s.label}`} onChange={(on) => set(rowKeys, on)} />
                            <div className="min-w-0">
                              <p className="text-foreground truncate font-medium">{s.label}</p>
                              {s.hint && <p className="text-muted-foreground truncate text-[11px] leading-tight">{s.hint}</p>}
                            </div>
                          </div>
                        </td>
                        {columns.map((c) => {
                          const item = s.actions.find((x) => x.action === c.action)
                          return (
                            <td key={c.action} className="px-2 py-3 text-center">
                              {item ? (
                                <span className="flex justify-center">
                                  <Switch
                                    state={isOn(item.key) ? 'on' : 'off'}
                                    disabled={readOnly}
                                    label={`${item.label} on ${s.label}`}
                                    onChange={(on) => set([item.key], on)}
                                  />
                                </span>
                              ) : (
                                <span className="text-border select-none" aria-hidden>
                                  —
                                </span>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </FormFrame>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-right">
      <p className="text-foreground text-lg font-semibold tabular-nums leading-none">{value}</p>
      <p className="text-muted-foreground mt-1 text-[11px]">{label}</p>
    </div>
  )
}

/** The switch in a cell: on, off, or partly on for a column heading. */
function Switch({
  state,
  disabled,
  label,
  onChange,
}: {
  state: Tri
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
        'relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 disabled:cursor-default',
        state === 'on' ? 'bg-emerald-500' : state === 'some' ? 'bg-emerald-500/40' : 'bg-slate-300',
      )}
    >
      <span
        className={cn(
          'absolute left-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
          state === 'on' && 'translate-x-[18px]',
          state === 'some' && 'translate-x-[9px]',
        )}
      />
    </button>
  )
}

/** The tick at the start of a row: the whole screen on, off, or partly. */
function Tick({
  state,
  disabled,
  label,
  onChange,
}: {
  state: Tri
  disabled?: boolean
  label: string
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'on' ? 'true' : state === 'some' ? 'mixed' : 'false'}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(state !== 'on')}
      className={cn(
        'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 disabled:cursor-default',
        state === 'off' ? 'border-slate-300 bg-card' : 'border-emerald-500 bg-emerald-500 text-white',
      )}
    >
      {state === 'on' && <Check size={12} strokeWidth={3} />}
      {state === 'some' && <Minus size={12} strokeWidth={3} />}
    </button>
  )
}
