'use client'

import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, ShieldCheck } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { settingsApi, type PermissionModule, type SettingsRole } from '@/lib/settingsApi'
import { Field, Notice } from './ui'

/**
 * The permission matrix.
 *
 * Absolute ERP hides this behind a page that loads its roles by AJAX and shows
 * a wall of unlabelled checkboxes. Here it is one grid: modules down the side,
 * the six things you can do across the top, with a row and a column that tick
 * everything at once.
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
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(role?.name ?? '')
    setDescription(role?.description ?? '')
    setGranted(new Set(role?.permissions ?? []))
    setErrors({})
    setFormError(null)
  }, [open, role])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  const readOnly = Boolean(role?.unrestricted)

  const total = useMemo(
    () => modules.reduce((sum, m) => sum + m.actions.length, 0),
    [modules],
  )

  if (!open) return null

  const toggle = (key: string) => {
    if (readOnly) return
    setGranted((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
        // Being able to add something you cannot see is not a coherent grant,
        // so view comes along with any other action on the same module.
        const [module] = key.split(':')
        next.add(`${module}:view`)
      }
      return next
    })
  }

  const toggleModule = (m: PermissionModule) => {
    if (readOnly) return
    const keys = m.actions.map((a) => a.key)
    const allOn = keys.every((k) => granted.has(k))
    setGranted((prev) => {
      const next = new Set(prev)
      for (const k of keys) (allOn ? next.delete(k) : next.add(k))
      return next
    })
  }

  const toggleAction = (action: string) => {
    if (readOnly) return
    const keys = modules
      .filter((m) => m.actions.some((a) => a.action === action))
      .map((m) => `${m.module}:${action}`)
    const allOn = keys.every((k) => granted.has(k))

    setGranted((prev) => {
      const next = new Set(prev)
      for (const k of keys) {
        if (allOn) {
          next.delete(k)
        } else {
          next.add(k)
          if (action !== 'view') next.add(`${k.split(':')[0]}:view`)
        }
      }
      return next
    })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    setFormError(null)

    const payload: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim() || null,
    }
    // The Admin role always has everything, and the API rejects an attempt to
    // narrow it, so its grants are simply not sent.
    if (!readOnly) payload.permissions = [...granted]

    try {
      if (role) {
        const res = await settingsApi.roles.update(role.id, payload)
        onSaved(res.message ?? `${payload.name} updated.`)
      } else {
        await settingsApi.roles.create(payload)
        onSaved(`Role "${payload.name}" created.`)
      }
      onClose()
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fieldErrors) setErrors(err.fieldErrors)
        setFormError(err.fieldErrors ? 'Please correct the highlighted fields.' : err.message)
      } else {
        setFormError('Could not save. Is the API running?')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div className="glass-card w-full max-w-4xl my-auto" role="dialog" aria-modal="true">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {role ? `Edit "${role.name}"` : 'New role'}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {readOnly
                ? 'Administrators always have full access'
                : `${granted.size} of ${total} permissions granted`}
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-5">
          {formError && <Notice kind="error">{formError}</Notice>}

          {readOnly && (
            <Notice kind="info">
              <span className="flex items-center gap-2">
                <ShieldCheck size={14} />
                The Admin role bypasses these permissions entirely, so ticking or unticking anything
                here would have no effect. Create a separate role if you need a narrower one.
              </span>
            </Notice>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Role name" htmlFor="role-name" required error={errors.name}>
              <input
                id="role-name"
                className="form-input"
                placeholder="Cutting Supervisor"
                value={name}
                disabled={Boolean(role?.isSystem)}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>

            <Field
              label="Description"
              htmlFor="role-desc"
              error={errors.description}
              help="A line on what this role is for"
            >
              <input
                id="role-desc"
                className="form-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </div>

          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 pr-4 font-medium text-xs uppercase tracking-wide text-muted-foreground">
                    Module
                  </th>
                  {actions.map((a) => (
                    <th key={a.action} className="px-2 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => toggleAction(a.action)}
                        disabled={readOnly}
                        className="text-xs font-medium text-muted-foreground hover:text-teal-400 transition-colors disabled:hover:text-muted-foreground"
                        title={`Tick ${a.label} everywhere`}
                      >
                        {a.label}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {modules.map((m) => {
                  const keys = m.actions.map((a) => a.key)
                  const allOn = keys.every((k) => granted.has(k))
                  const someOn = keys.some((k) => granted.has(k))

                  return (
                    <tr key={m.module} className="border-b border-border/50">
                      <td className="py-2 pr-4">
                        <button
                          type="button"
                          onClick={() => toggleModule(m)}
                          disabled={readOnly}
                          className="text-left hover:text-teal-400 transition-colors disabled:hover:text-foreground"
                          title="Tick everything on this module"
                        >
                          <span className={allOn ? 'text-teal-400' : someOn ? 'text-foreground' : ''}>
                            {m.label}
                          </span>
                        </button>
                      </td>

                      {actions.map((a) => {
                        const cell = m.actions.find((x) => x.action === a.action)
                        if (!cell) return <td key={a.action} className="text-center text-muted-foreground">—</td>

                        const on = readOnly || granted.has(cell.key)
                        return (
                          <td key={a.action} className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              className="accent-teal-500 w-4 h-4"
                              checked={on}
                              disabled={readOnly}
                              onChange={() => toggle(cell.key)}
                              aria-label={`${a.label} ${m.label}`}
                            />
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3 pt-3 border-t border-border">
            <p className="text-xs text-muted-foreground">
              People already signed in pick up a change within 15 minutes.
            </p>
            <div className="flex items-center gap-3">
              <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={saving || !name.trim()}>
                {saving && <Loader2 size={15} className="animate-spin" />}
                {role ? 'Save changes' : 'Create role'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
