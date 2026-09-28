'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  X,
  Loader2,
  AlertCircle,
  Save,
  Boxes,
  CreditCard,
  Database,
  Factory,
  FileText,
  FolderTree,
  Gauge,
  Handshake,
  IndianRupee,
  Landmark,
  Layers,
  MapPin,
  Package,
  Palette,
  Percent,
  Phone,
  Receipt,
  Route,
  Ruler,
  Shirt,
  Tag,
  Truck,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'
import { ApiError, masterResource, type Paginated } from '@/lib/api'
import { Section } from '@/components/purchase/Section'

/** The tile in the form's title bar, by master. */
const RESOURCE_ICONS: Record<string, LucideIcon> = {
  items: Package,
  'item-categories': FolderTree,
  styles: Shirt,
  'size-groups': Ruler,
  sizes: Ruler,
  customers: Users,
  suppliers: Truck,
  brokers: Handshake,
  workstations: Factory,
  charges: Receipt,
  'charge-types': Receipt,
  warehouses: Warehouse,
  'bank-accounts': Landmark,
  routings: Route,
}

/** Each panel's icon, by the section name the screens already give their fields. */
const SECTION_ICONS: Record<string, LucideIcon> = {
  Identity: Tag,
  Contact: Phone,
  Address: MapPin,
  'Bank Details': Landmark,
  Tax: Receipt,
  Costing: IndianRupee,
  'Stock Control': Boxes,
  'Payment Terms': CreditCard,
  Terms: FileText,
  Commission: Percent,
  Construction: Layers,
  'Size & Colour': Palette,
  Capacity: Gauge,
  Other: FileText,
}

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
  /**
   * Filled in by the server, not by the person.
   *
   * A master code is a handle, not information — nobody decides a customer
   * should be CUS-017 rather than CUS-018. Asking for one on a form is asking
   * somebody to do the computer's job, and it is how a register ends up with
   * CUST-1, Cust001 and C-1 all meaning different firms.
   *
   * So the field is not shown when adding. It is shown, greyed out, when
   * editing — because by then it is on documents and people quote it.
   */
  generated?: boolean
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
  const bodyRef = useRef<HTMLDivElement>(null)

  // Reset whenever the dialog opens, so a previous record's values and errors
  // never leak into the next one.
  useEffect(() => {
    if (!open) return

    const seed: Record<string, unknown> = {}
    for (const f of fields) {
      const existing = record ? (record as Record<string, unknown>)[f.name] : undefined
      if (existing !== undefined && existing !== null) {
        seed[f.name] = f.type === 'tags' && Array.isArray(existing) ? existing.join(', ') : existing
      } else if (f.type === 'checkbox') {
        // A new record is added to be used. Starting "Active" unticked saved
        // every new item, customer and supplier as inactive, so it vanished
        // from the list and never appeared in a single dropdown.
        seed[f.name] = !record && f.name === 'isActive'
      } else {
        seed[f.name] = ''
      }
    }
    setValues(seed)
    setFieldErrors({})
    setFormError(null)
  }, [open, record, fields])

  // The cursor starts in the first box, so a clerk can type straight away.
  useEffect(() => {
    if (!open) return
    const first = bodyRef.current?.querySelector<HTMLElement>(
      'input:not([disabled]):not([type=checkbox]), select, textarea',
    )
    first?.focus()
  }, [open])

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
      // Sending back a value nobody could have changed only risks a clash with
      // a code the server has since handed to somebody else.
      if (f.generated) continue

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
      bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    } finally {
      setSaving(false)
    }
  }

  // A generated field has nothing to show before the record exists.
  const visibleFields = fields.filter((f) => !f.generated || isEdit)

  const sections = visibleFields.reduce<Record<string, FormField[]>>((acc, f) => {
    const key = f.section ?? ''
    ;(acc[key] ??= []).push(f)
    return acc
  }, {})

  const HeaderIcon = RESOURCE_ICONS[resource] ?? Database
  const heading = isEdit ? `Edit ${title}` : `New ${title}`
  const code = isEdit ? (visibleFields.find((f) => f.generated) ?? null) : null
  const codeValue = code ? String(values[code.name] ?? '') : ''

  const saveButton = (
    <button type="submit" form="master-form" className="btn-primary" disabled={saving}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
      {isEdit ? 'Save changes' : `Save ${title.toLowerCase()}`}
    </button>
  )

  /*
   * The same frame as the purchase forms.
   *
   * Portalled to <body>. Drawn inside the page it sat in whatever box the page
   * transition had made, so `fixed` measured from that box and the top of the
   * screen showed a strip of the page above the dimmed cover.
   *
   * The cover stops where the sidebar ends, so the menu is neither dimmed nor
   * covered and you can still move to another screen with the form open. On
   * a phone the sidebar is a drawer, so there the cover takes the full width.
   */
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      {/* Capped and centred. A master has a dozen fields, not an item table;
        stretched across a wide screen each box ran half the monitor long. */}
      <form
        id="master-form"
        onSubmit={submit}
        noValidate
        className="glass-card po-form flex h-full max-h-full w-full max-w-5xl flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="master-form-title"
      >
        {/* Header: stays put while the body scrolls, so it is always clear what is being filled in. */}
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <HeaderIcon size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2
                id="master-form-title"
                className="text-foreground truncate text-xl font-semibold tracking-tight"
              >
                {heading}
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {isEdit
                  ? codeValue
                    ? `${codeValue} · changes apply to new documents from now on`
                    : 'Changes apply to new documents from now on'
                  : 'The code is given by the system when you save'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden md:block">{saveButton}</div>
            <button type="button" onClick={onClose} className="btn-ghost p-2" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body: the only thing that scrolls. */}
        <div ref={bodyRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {formError && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{formError}</p>
            </div>
          )}

          {Object.entries(sections).map(([section, sectionFields]) => (
            <Section
              key={section || 'details'}
              icon={SECTION_ICONS[section] ?? FileText}
              title={section || 'Details'}
            >
              <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
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
            </Section>
          ))}
        </div>

        {/* Footer: always in reach, however long the form. */}
        <div className="border-border flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">
          <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
            Cancel
          </button>
          {saveButton}
        </div>
      </form>
    </div>,
    document.body,
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
  // A description or an address is read as a paragraph, so it takes the whole
  // row; a two-wide field takes two of the three columns.
  const wrapper =
    type === 'textarea' ? 'min-w-0 col-span-full' : field.span === 2 ? 'min-w-0 md:col-span-2' : 'min-w-0'
  const invalid = Boolean(error)
  const inputClass = `form-input placeholder:text-muted-foreground/60 ${invalid ? 'border-red-500/60' : ''}`
  // The screens give a sample value as the hint. Shown bare, "Rajan Traders"
  // or "500" in an empty box reads as already filled in; "e.g." says it is not.
  const hint = field.placeholder ? `e.g. ${field.placeholder}` : undefined

  // Only ever reached when editing — a generated field is filtered out of a
  // create form entirely. It is shown because the code is on documents by now
  // and people quote it, and locked because changing it would orphan them.
  if (field.generated) {
    return (
      <div className={wrapper}>
        <label className="form-label" htmlFor={field.name}>
          {field.label}
        </label>
        <input
          id={field.name}
          className="form-input font-mono text-muted-foreground cursor-not-allowed"
          value={String(value ?? '')}
          readOnly
          disabled
        />
        <p className="form-help">
          Given by the system. It appears on documents, so it cannot be changed.
        </p>
      </div>
    )
  }

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
          placeholder={hint}
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

      {/* Boxed at the same height as the fields beside it, so a tick box
        lines up with its row instead of floating under its label. */}
      {type === 'checkbox' && (
        <label className="form-readout text-foreground h-[2.625rem] cursor-pointer select-none items-center">
          <input
            id={field.name}
            type="checkbox"
            className="h-4 w-4 shrink-0 accent-teal-500"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="min-w-0 truncate">{field.placeholder ?? 'Yes'}</span>
        </label>
      )}

      {(type === 'text' || type === 'number' || type === 'date' || type === 'tags') && (
        <input
          id={field.name}
          type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
          step={type === 'number' ? 'any' : undefined}
          className={inputClass}
          placeholder={hint}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {error ? (
        <p className="form-help !text-red-400">{error}</p>
      ) : field.help ? (
        <p className="form-help">{field.help}</p>
      ) : null}
    </div>
  )
}
