'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Loader2, AlertCircle } from 'lucide-react'
import { ApiError, masterResource, type Paginated } from '@/lib/api'

export type FieldType = 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date' | 'tags'

export interface FormField {
  name: string
  label: string
  type?: FieldType
  required?: boolean
  placeholder?: string
  options?: { value: string; label: string }[]
  /**
   * Populates a select from a master endpoint instead of a fixed list, for
   * foreign keys like an item's category or unit of measure.
   */
  optionsFrom?: {
    /** Master endpoint segment, e.g. 'item-categories'. */
    resource: string
    /** Record field used as the option value. Defaults to 'id'. */
    valueKey?: string
    /** Record field shown to the user. Defaults to 'name'. */
    labelKey?: string
  }
  /** Short hint rendered under the input. */
  help?: string
  /** Forces capitals as you type — GSTIN, PAN, IFSC and codes are never lower case. */
  uppercase?: boolean
  /**
   * Fills another field from this one. Used so typing a GSTIN sets the state
   * code, which is what actually decides the tax on every document.
   */
  derives?: { field: string; from: (value: string) => string | null }
  /** Fraction of the two-column grid this field occupies. */
  span?: 1 | 2
  /** Grouping heading this field sits under. */
  section?: string
}

interface MasterFormDialogProps<T> {
  open: boolean
  onClose: () => void
  /** Called after a successful save so the list can refresh. */
  onSaved: () => void
  resource: string
  fields: FormField[]
  /** Present when editing; absent when creating. */
  record?: T | null
  title: string
}

export function MasterFormDialog<T extends { id: string }>({
  open,
  onClose,
  onSaved,
  resource,
  fields,
  record,
  title,
}: MasterFormDialogProps<T>) {
  const isEdit = Boolean(record)
  const client = useMemo(() => masterResource<T>(resource), [resource])

  const [values, setValues] = useState<Record<string, unknown>>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Reset whenever the dialog opens, so a previous record's values and errors
  // never leak into the next one.
  useEffect(() => {
    if (!open) return

    const seed: Record<string, unknown> = {}
    for (const f of fields) {
      const existing = record ? (record as Record<string, unknown>)[f.name] : undefined
      if (existing !== undefined && existing !== null) {
        seed[f.name] = f.type === 'tags' && Array.isArray(existing) ? existing.join(', ') : existing
      } else {
        seed[f.name] = f.type === 'checkbox' ? false : ''
      }
    }
    setValues(seed)
    setFieldErrors({})
    setFormError(null)
  }, [open, record, fields])

  // Foreign-key selects load their choices from the API the first time the
  // dialog opens, keyed by field name.
  const [remoteOptions, setRemoteOptions] = useState<
    Record<string, { value: string; label: string }[]>
  >({})

  useEffect(() => {
    if (!open) return

    const remoteFields = fields.filter((f) => f.optionsFrom)
    if (remoteFields.length === 0) return

    let cancelled = false

    void Promise.all(
      remoteFields.map(async (f) => {
        const { resource: r, valueKey = 'id', labelKey = 'name' } = f.optionsFrom!
        try {
          const res = (await masterResource<Record<string, unknown>>(r).list({
            limit: 200,
            active: true,
          })) as Paginated<Record<string, unknown>>
          return [
            f.name,
            res.data.map((row) => ({
              value: String(row[valueKey] ?? ''),
              label: String(row[labelKey] ?? row[valueKey] ?? ''),
            })),
          ] as const
        } catch {
          // A failed lookup leaves the select empty rather than breaking the
          // whole form; the required-field error still guides the user.
          return [f.name, []] as const
        }
      }),
    ).then((entries) => {
      if (!cancelled) setRemoteOptions(Object.fromEntries(entries))
    })

    return () => {
      cancelled = true
    }
  }, [open, fields])

  // Escape closes, and the page behind must not scroll while the dialog is up.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null

  const set = (name: string, value: unknown) => {
    const field = fields.find((f) => f.name === name)
    const next = field?.uppercase && typeof value === 'string' ? value.toUpperCase() : value

    setValues((v) => {
      const updated = { ...v, [name]: next }

      // One field can fill in another — a GSTIN gives the state code away, and
      // nobody should have to know that to get their tax right.
      if (field?.derives && typeof next === 'string') {
        const derived = field.derives.from(next)
        if (derived) updated[field.derives.field] = derived
      }

      return updated
    })

    // Clearing as the user types keeps a stale server error from sitting under
    // a field they have already corrected.
    setFieldErrors((e) => (e[name] ? { ...e, [name]: '' } : e))
  }

  /** Blank optional fields must be omitted, not sent as "", which fails Zod. */
  const buildPayload = () => {
    const payload: Record<string, unknown> = {}

    for (const f of fields) {
      const raw = values[f.name]

      if (f.type === 'checkbox') {
        payload[f.name] = Boolean(raw)
        continue
      }

      if (raw === '' || raw === undefined || raw === null) {
        if (f.required) payload[f.name] = raw
        continue
      }

      if (f.type === 'number') {
        payload[f.name] = Number(raw)
      } else if (f.type === 'tags') {
        payload[f.name] = String(raw)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      } else {
        payload[f.name] = raw
      }
    }

    return payload
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    setFieldErrors({})

    try {
      const payload = buildPayload()
      if (isEdit && record) {
        await client.update(record.id, payload as Partial<T>)
      } else {
        await client.create(payload as Partial<T>)
      }
      onSaved()
      onClose()
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fieldErrors) setFieldErrors(err.fieldErrors)

        // Naming the fields matters. "Please correct the highlighted fields"
        // is useless when the offending one has scrolled out of sight.
        const named = err.fieldErrors
          ? Object.entries(err.fieldErrors)
              .filter(([, m]) => m)
              .map(([key]) => fields.find((f) => f.name === key)?.label ?? key)
          : []

        setFormError(
          named.length
            ? `Could not save. Check ${named.join(', ')} — the problem is marked in red below.`
            : err.message,
        )
      } else {
        setFormError('Could not save. Is the API running?')
      }

      // The banner sits at the top of a long form; without this it is often
      // off-screen and the save looks as though it simply did nothing.
      dialogRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } finally {
      setSaving(false)
    }
  }

  const sections = fields.reduce<Record<string, FormField[]>>((acc, f) => {
    const key = f.section ?? ''
    ;(acc[key] ??= []).push(f)
    return acc
  }, {})

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div
        ref={dialogRef}
        className="glass-card w-full max-w-3xl my-auto"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            {isEdit ? `Edit ${title}` : `New ${title}`}
          </h2>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-6">
          {formError && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
              <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-red-400">{formError}</p>
            </div>
          )}

          {Object.entries(sections).map(([section, sectionFields]) => (
            <div key={section} className="space-y-4">
              {section && (
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {section}
                </h3>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {sectionFields.map((f) => (
                  <Field
                    key={f.name}
                    field={f}
                    value={values[f.name]}
                    error={fieldErrors[f.name]}
                    options={f.optionsFrom ? remoteOptions[f.name] : f.options}
                    onChange={(v) => set(f.name, v)}
                  />
                ))}
              </div>
            </div>
          ))}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
            <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving && <Loader2 size={15} className="animate-spin" />}
              {isEdit ? 'Save changes' : `Create ${title}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function Field({
  field,
  value,
  error,
  options,
  onChange,
}: {
  field: FormField
  value: unknown
  error?: string
  options?: { value: string; label: string }[]
  onChange: (v: unknown) => void
}) {
  const type = field.type ?? 'text'
  const wrapper = field.span === 2 || type === 'textarea' ? 'md:col-span-2' : ''
  const invalid = Boolean(error)
  const inputClass = `form-input ${invalid ? 'border-red-500/60' : ''}`

  return (
    <div className={wrapper}>
      <label className="form-label" htmlFor={field.name}>
        {field.label}
        {field.required && <span className="text-red-400 ml-0.5">*</span>}
      </label>

      {type === 'textarea' && (
        <textarea
          id={field.name}
          rows={3}
          className={inputClass}
          placeholder={field.placeholder}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {type === 'select' && (
        <select
          id={field.name}
          className={inputClass}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">
            {field.optionsFrom && !options ? 'Loading...' : 'Select...'}
          </option>
          {options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {type === 'checkbox' && (
        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer select-none h-10">
          <input
            id={field.name}
            type="checkbox"
            className="accent-teal-500"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.placeholder ?? 'Yes'}
        </label>
      )}

      {(type === 'text' || type === 'number' || type === 'date' || type === 'tags') && (
        <input
          id={field.name}
          type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
          step={type === 'number' ? 'any' : undefined}
          className={inputClass}
          placeholder={field.placeholder}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {error ? (
        <p className="text-xs text-red-400 mt-1">{error}</p>
      ) : field.help ? (
        <p className="text-xs text-muted-foreground mt-1">{field.help}</p>
      ) : null}
    </div>
  )
}
