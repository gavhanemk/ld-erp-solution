'use client'

import { useEffect, useState } from 'react'
import { KeyRound, Loader2, ShieldCheck, UserPlus, UserRound } from 'lucide-react'
import { ApiError, currentUser } from '@/lib/api'
import { settingsApi, type SettingsRole, type SettingsUser } from '@/lib/settingsApi'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { Field, FieldGrid, Notice } from './ui'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Add someone, or change their details. Passwords are handled separately.
 *
 * In the same window as every other form — it used to cover the menu and blur
 * the whole screen, and sat a strip below the top of the page because it was
 * drawn inside the page rather than over it.
 */
export function UserDialog({
  open,
  onClose,
  onSaved,
  user,
  roles,
  /** The signed-in user's id, so the form can explain what they may not change. */
  selfId,
  onShowRole,
}: {
  open: boolean
  onClose: () => void
  onSaved: (message: string) => void
  user: SettingsUser | null
  roles: SettingsRole[]
  selfId: string | null
  /** Opens the access matrix of the chosen role. */
  onShowRole?: (role: SettingsRole) => void
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

  if (!open) return null

  const set = (key: string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }))
    setErrors((e) => (e[key] ? { ...e, [key]: '' } : e))
  }

  const submit = async () => {
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

  const chosen = roles.find((r) => r.id === values.roleId)
  const screens = chosen && !chosen.unrestricted
    ? new Set(chosen.permissions.filter((k) => k.endsWith(':view')).map((k) => k.split(':')[0])).size
    : null

  return (
    <FormFrame
      icon={isEdit ? UserRound : UserPlus}
      title={isEdit ? `Edit ${user?.name}` : 'Add a person'}
      subtitle={isEdit ? user?.email : 'Someone who can sign in to the ERP'}
      primary={
        <button type="button" className="btn-primary" onClick={() => void submit()} disabled={saving}>
          {saving && <Loader2 size={15} className="animate-spin" />}
          {isEdit ? 'Save changes' : 'Add person'}
        </button>
      }
      footer={
        <button type="button" onClick={onClose} className="btn-ghost" disabled={saving}>
          Cancel
        </button>
      }
      error={formError}
      onClose={onClose}
      busy={saving}
      width="max-w-3xl"
    >
      {isSelf && (
        <Notice kind="info">
          This is your own account, so your role and status are not editable here. Ask another administrator if they
          need to change.
        </Notice>
      )}

      <Section icon={UserRound} title="Who they are">
        <FieldGrid cols={2}>
          <Field label="Full name" htmlFor="u-name" required error={errors.name}>
            <input
              id="u-name"
              className="form-input"
              placeholder="Mahesh Gavhane"
              value={values.name ?? ''}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field label="Email" htmlFor="u-email" required error={errors.email} help="What they sign in with">
            <input
              id="u-email"
              type="email"
              className="form-input"
              placeholder="name@ldcottonmills.com"
              value={values.email ?? ''}
              onChange={(e) => set('email', e.target.value)}
            />
          </Field>
          <Field label="Phone" htmlFor="u-phone" error={errors.phone}>
            <input
              id="u-phone"
              type="tel"
              className="form-input"
              value={values.phone ?? ''}
              onChange={(e) => set('phone', e.target.value)}
            />
          </Field>
          <Field label="Employee code" htmlFor="u-code" error={errors.employeeCode} help="Optional, if you use one">
            <input
              id="u-code"
              className="form-input"
              value={values.employeeCode ?? ''}
              onChange={(e) => set('employeeCode', e.target.value)}
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section icon={ShieldCheck} title="Access">
        <FieldGrid cols={2}>
          <Field
            label="Role"
            htmlFor="u-role"
            required
            error={errors.roleId}
            help={
              isSelf ? (
                'Your own role cannot be changed here'
              ) : chosen ? (
                <span>
                  {chosen.unrestricted ? 'Every screen and every action, always.' : `Opens ${screens} screens.`}{' '}
                  {onShowRole && (
                    <button type="button" className="text-primary font-medium hover:underline" onClick={() => onShowRole(chosen)}>
                      See what this role can do
                    </button>
                  )}
                </span>
              ) : (
                'Decides what they can see and do'
              )
            }
          >
            <SmartSelect
              id="u-role"
              className="form-input"
              value={values.roleId ?? ''}
              disabled={isSelf}
              onChange={(e) => set('roleId', e.target.value)}
            >
              <option value="">Select...</option>
              {/* Super Admin is offered only by a Super Admin; the server refuses anyone else. */}
              {roles
                .filter((r) => !r.unrestricted || currentUser()?.superAdmin || r.id === values.roleId)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </SmartSelect>
          </Field>
          <Field label="Status" htmlFor="u-status" error={errors.status}>
            <SmartSelect
              id="u-status"
              className="form-input"
              value={values.status ?? 'ACTIVE'}
              disabled={isSelf}
              onChange={(e) => set('status', e.target.value)}
            >
              <option value="ACTIVE">Active — can sign in</option>
              <option value="INACTIVE">Inactive — cannot sign in</option>
              <option value="SUSPENDED">Suspended — cannot sign in</option>
            </SmartSelect>
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
                autoComplete="off"
                className="form-input font-mono"
                value={values.password ?? ''}
                onChange={(e) => set('password', e.target.value)}
              />
            </Field>
          )}
        </FieldGrid>
      </Section>
    </FormFrame>
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

  const submit = async () => {
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
    <FormFrame
      icon={KeyRound}
      title="Reset password"
      subtitle={`${user.name} · ${user.email}`}
      primary={
        <button type="button" className="btn-primary" onClick={() => void submit()} disabled={saving || password.length < 8}>
          {saving && <Loader2 size={15} className="animate-spin" />}
          Reset password
        </button>
      }
      footer={
        <button type="button" onClick={onClose} className="btn-ghost" disabled={saving}>
          Cancel
        </button>
      }
      footerNote="Tell them the new password yourself — the ERP does not email it."
      error={error}
      onClose={onClose}
      busy={saving}
      width="max-w-xl"
      primaryInHeader={false}
    >
      <Field label="New password" htmlFor="reset-pw" required help="At least 8 characters with a letter and a number">
        <input
          id="reset-pw"
          type="text"
          autoComplete="off"
          className="form-input font-mono"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
    </FormFrame>
  )
}
