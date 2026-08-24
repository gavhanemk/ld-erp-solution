'use client'

import { useEffect, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { settingsApi, type SettingsRole, type SettingsUser } from '@/lib/settingsApi'
import { Field, Notice } from './ui'

/** Add someone, or change their details. Passwords are handled separately. */
export function UserDialog({
  open,
  onClose,
  onSaved,
  user,
  roles,
  /** The signed-in user's id, so the form can explain what they may not change. */
  selfId,
}: {
  open: boolean
  onClose: () => void
  onSaved: (message: string) => void
  user: SettingsUser | null
  roles: SettingsRole[]
  selfId: string | null
}) {
  const isEdit = Boolean(user)
  const isSelf = Boolean(user && user.id === selfId)

  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setValues({
      name: user?.name ?? '',
      email: user?.email ?? '',
      phone: user?.phone ?? '',
      employeeCode: user?.employeeCode ?? '',
      roleId: user?.roleId ?? '',
      status: user?.status ?? 'ACTIVE',
      password: '',
    })
    setErrors({})
    setFormError(null)
  }, [open, user])

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

  if (!open) return null

  const set = (key: string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }))
    setErrors((e) => (e[key] ? { ...e, [key]: '' } : e))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    setFormError(null)

    const payload: Record<string, unknown> = {
      name: values.name.trim(),
      email: values.email.trim().toLowerCase(),
      phone: values.phone.trim() || null,
      employeeCode: values.employeeCode.trim() || null,
      roleId: values.roleId,
      status: values.status,
    }

    // The API refuses either of these on your own account; leaving them out
    // keeps a no-op save from being rejected outright.
    if (isSelf) {
      delete payload.roleId
      delete payload.status
    }

    try {
      if (isEdit && user) {
        await settingsApi.users.update(user.id, payload)
        onSaved(`${payload.name} updated.`)
      } else {
        await settingsApi.users.create({ ...payload, password: values.password })
        onSaved(`${payload.name} can now sign in.`)
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
      <div className="glass-card w-full max-w-2xl my-auto" role="dialog" aria-modal="true">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            {isEdit ? `Edit ${user?.name}` : 'Add a person'}
          </h2>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-5">
          {formError && <Notice kind="error">{formError}</Notice>}

          {isSelf && (
            <Notice kind="info">
              This is your own account, so your role and status are not editable here. Ask another
              administrator if they need to change.
            </Notice>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Full name" htmlFor="u-name" required error={errors.name}>
              <input
                id="u-name"
                className="form-input"
                placeholder="Mahesh Ghavane"
                value={values.name ?? ''}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>

            <Field
              label="Email"
              htmlFor="u-email"
              required
              error={errors.email}
              help="This is what they sign in with"
            >
              <input
                id="u-email"
                className="form-input"
                placeholder="name@ldcottonmills.com"
                value={values.email ?? ''}
                onChange={(e) => set('email', e.target.value)}
              />
            </Field>

            <Field label="Phone" htmlFor="u-phone" error={errors.phone}>
              <input
                id="u-phone"
                className="form-input"
                value={values.phone ?? ''}
                onChange={(e) => set('phone', e.target.value)}
              />
            </Field>

            <Field
              label="Employee code"
              htmlFor="u-code"
              error={errors.employeeCode}
              help="Optional, if you use one"
            >
              <input
                id="u-code"
                className="form-input"
                value={values.employeeCode ?? ''}
                onChange={(e) => set('employeeCode', e.target.value)}
              />
            </Field>

            <Field
              label="Role"
              htmlFor="u-role"
              required
              error={errors.roleId}
              help={isSelf ? 'Your own role cannot be changed here' : 'Decides what they can see and do'}
            >
              <select
                id="u-role"
                className="form-input"
                value={values.roleId ?? ''}
                disabled={isSelf}
                onChange={(e) => set('roleId', e.target.value)}
              >
                <option value="">Select...</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Status" htmlFor="u-status" error={errors.status}>
              <select
                id="u-status"
                className="form-input"
                value={values.status ?? 'ACTIVE'}
                disabled={isSelf}
                onChange={(e) => set('status', e.target.value)}
              >
                <option value="ACTIVE">Active — can sign in</option>
                <option value="INACTIVE">Inactive — cannot sign in</option>
                <option value="SUSPENDED">Suspended — cannot sign in</option>
              </select>
            </Field>

            {!isEdit && (
              <Field
                label="Starting password"
                htmlFor="u-password"
                required
                error={errors.password}
                help="At least 8 characters with a letter and a number. Ask them to change it after their first sign-in."
                span={2}
              >
                <input
                  id="u-password"
                  type="text"
                  className="form-input font-mono"
                  value={values.password ?? ''}
                  onChange={(e) => set('password', e.target.value)}
                />
              </Field>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
            <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving && <Loader2 size={15} className="animate-spin" />}
              {isEdit ? 'Save changes' : 'Add person'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** Sets a new password for someone else. The old one is never needed. */
export function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: SettingsUser | null
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setPassword('')
    setError(null)
  }, [user])

  if (!user) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const res = await settingsApi.users.resetPassword(user.id, password)
      onDone(res.message)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset the password.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="glass-card w-full max-w-md" role="dialog" aria-modal="true">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Reset password</h2>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          {error && <Notice kind="error">{error}</Notice>}

          <p className="text-sm text-muted-foreground">
            Set a new password for <span className="text-foreground font-medium">{user.name}</span>.
            They will need to be told what it is — the ERP does not email it.
          </p>

          <Field
            label="New password"
            htmlFor="reset-pw"
            required
            help="At least 8 characters with a letter and a number"
          >
            <input
              id="reset-pw"
              type="text"
              className="form-input font-mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
            <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving || password.length < 8}>
              {saving && <Loader2 size={15} className="animate-spin" />}
              Reset password
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
