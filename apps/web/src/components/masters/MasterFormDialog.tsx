'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  X,
  Loader2,
  AlertCircle,
  Save,
  Boxes,
  Building2,
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
  Scale,
  Shirt,
  Tag,
  Truck,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'
import { ApiError, can, masterResource, type Paginated, type Single } from '@/lib/api'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { SuggestInput } from '@/components/ui/SuggestInput'

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
  departments: Building2,
  brands: Tag,
  uoms: Scale,
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
  'Costing & Stock': IndianRupee,
  Other: FileText,
  'Identity & Contact': Tag,
  'Credit, Bank & Notes': CreditCard,
  'Address & Terms': MapPin,
  'Bank, MSME & Notes': Landmark,
  'Commission & Notes': Percent,
  'Workstation': Tag,
  Style: Tag,
}

/** Fields per row by screen width. Written out whole so Tailwind keeps them. */
const GRID = {
  3: 'md:grid-cols-2 xl:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
} as const

/** How far a wide field reaches, for each grid. */
const SPAN = {
  3: { 1: '', 2: 'md:col-span-2', 3: 'col-span-full' },
  4: { 1: '', 2: 'sm:col-span-2', 3: 'sm:col-span-2 lg:col-span-3' },
} as const

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
    /**
     * Keeps only the rows this returns true for, given what is on the form
     * now. How a sub-category list shows only the chosen category's children.
     */
    filter?: (row: Record<string, unknown>, values: Record<string, unknown>) => boolean
  }
  /**
   * Offers "Add new …" in an optionsFrom select, for a choice that is not in
   * the list yet: a unit nobody has needed before. It opens that master's own
   * form over this one, saves it to the master, and picks it here, so it is
   * in the list from then on.
   */
  createFrom?: {
    /** The master's form, the same one its own page uses. */
    fields: FormField[]
    /** Its name in the form's title: "Unit of measure". */
    title: string
    /** What a new one is called in the list: "unit". */
    noun: string
    /** Which field of the new form takes what was typed in the search. Defaults to 'name'. */
    typedInto?: string
  }
  /**
   * Populates a select from a property on whatever record another field on
   * this same form currently points at — a colour picker showing exactly the
   * colours the chosen style offers, not a fixed master resource.
   */
  optionsFromField?: {
    /** Name of the field on this form holding the related record's id. */
    field: string
    /** Master endpoint segment that field's id belongs to, e.g. 'styles'. */
    resource: string
    /** Array property on that record to turn into options, e.g. 'colors'. */
    arrayKey: string
  }
  /**
   * Only rendered, and only required, while this returns true for the
   * form's current values — a colour field with nothing to choose from until
   * a style is picked.
   */
  showIf?: (values: Record<string, unknown>) => boolean
  /** Shown in place of "Select..." when a filtered list has nothing in it. */
  emptyLabel?: string
  /** Value to open an edit with, when it is not simply the record's own field. */
  initial?: (record: Record<string, unknown>) => unknown
  /**
   * Saved under another name. Two boxes may share one: Category and Sub
   * Category both save `categoryId`, and a sub-category, when chosen, wins
   * because it comes later.
   */
  sendAs?: string
  /** Fields emptied when this one changes, as a sub-category is when its category does. */
  resets?: string[]
  /**
   * Fills another field from the row picked here: a sub-category fills the
   * item's department with its own. Only over a value it filled itself, or
   * an empty one, so a department chosen by hand is never overwritten.
   */
  fills?: { field: string; from: (row: Record<string, unknown>) => unknown }
  /** Height of a textarea, in lines. */
  rows?: number
  /**
   * Limits on a number box, the same as the server's. A number box starts at
   * nought: a negative GST rate, stock level or credit limit means nothing,
   * so the minus sign is not taken at all unless `allowNegative` is set (an
   * opening balance, which can be overdrawn).
   */
  min?: number
  max?: number
  allowNegative?: boolean
  /**
   * Must be filled on this form, though the API allows it empty. True, or
   * 'ifOptions' for a list that is only asked for when it has something in
   * it: a sub-category, when the category chosen has any.
   *
   * On the form rather than in the API because other screens create the
   * same record more briefly (a purchase order's quick "new item" has no
   * department), and they must keep working.
   */
  mustFill?: boolean | 'ifOptions'
  /** Short hint rendered under the input. */
  help?: string
  /**
   * A hint worked out from what is typed, shown in place of `help` once it
   * returns something: a GST rate showing how it splits as it is entered.
   */
  liveHelp?: (value: unknown) => string | null
  /**
   * Suggestions for a text box from a master list, offered as the person
   * types but never forced: an item's HSN code suggested from the HSN master,
   * while a code not listed there yet can still be typed.
   */
  suggestFrom?: {
    resource: string
    valueKey: string
    label: (row: Record<string, unknown>) => string
  }
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
  /** How many grid columns this field takes. */
  span?: 1 | 2 | 3
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
  /**
   * Fields per row on a wide screen. Four suits a master of many short
   * fields, like an item, and keeps the whole form on one screen.
   */
  columns?: 3 | 4
  /** A wider card, for a master with many fields to set four across. */
  wide?: boolean
  /** Values a new record starts with: the name typed into a search that found nothing. */
  initialValues?: Record<string, unknown>
  /** The record just created, for a form that opened this one to pick it straight away. */
  onCreated?: (row: T) => void
  /** Opened from inside another dialog, so it has to sit above that one. */
  stacked?: boolean
}

export function MasterFormDialog<T extends { id: string }>({
  open,
  onClose,
  onSaved,
  resource,
  fields,
  record,
  title,
  columns = 3,
  wide = false,
  initialValues,
  onCreated,
  stacked = false,
}: MasterFormDialogProps<T>) {
  const isEdit = Boolean(record)
  const client = useMemo(() => masterResource<T>(resource), [resource])

  const [values, setValues] = useState<Record<string, unknown>>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // What `fills` last put in each field, to tell it from a person's choice.
  const filledBy = useRef<Record<string, unknown>>({})
  // Ids of this form's own, so a second form opened over it (see createFrom)
  // has a Save button and labels that point at its own boxes, not these.
  const uid = useId()
  // The select whose "Add new" opened a form over this one, and what was typed.
  const [adding, setAdding] = useState<{ field: FormField; typed: string } | null>(null)

  // Reset whenever the dialog opens, so a previous record's values and errors
  // never leak into the next one.
  useEffect(() => {
    if (!open) return

    const seed: Record<string, unknown> = {}
    for (const f of fields) {
      const existing = record
        ? f.initial
          ? f.initial(record as Record<string, unknown>)
          : (record as Record<string, unknown>)[f.name]
        : undefined
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
      if (!record && initialValues?.[f.name] != null && initialValues[f.name] !== '') {
        seed[f.name] = initialValues[f.name]
      }
    }
    setValues(seed)
    setFieldErrors({})
    setFormError(null)
    setAdding(null)
    filledBy.current = {}
    // initialValues is read once, when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // The rows themselves, not ready-made options, so a list that depends on
  // another field can be filtered again each time that field changes.
  const [remoteRows, setRemoteRows] = useState<Record<string, Record<string, unknown>[]>>({})
  // Options drawn from a record another field points at (see optionsFromField),
  // ready-made: they come from an array on one record, not from a list of rows.
  const [fieldOptions, setFieldOptions] = useState<Record<string, { value: string; label: string }[]>>({})

  useEffect(() => {
    if (!open) return

    const remoteFields = fields.filter((f) => f.optionsFrom || f.suggestFrom)
    if (remoteFields.length === 0) return

    let cancelled = false

    void Promise.all(
      remoteFields.map(async (f) => {
        try {
          const res = (await masterResource<Record<string, unknown>>(
            (f.optionsFrom ?? f.suggestFrom)!.resource,
          ).list({
            limit: 200,
            active: true,
          })) as Paginated<Record<string, unknown>>
          return [f.name, res.data] as const
        } catch {
          // A failed lookup leaves the select empty rather than breaking the
          // whole form; the required-field error still guides the user.
          return [f.name, []] as const
        }
      }),
    ).then((entries) => {
      if (!cancelled) setRemoteRows(Object.fromEntries(entries))
    })

    return () => {
      cancelled = true
    }
  }, [open, fields])

  // A field can also draw its options from a property on whatever record
  // another field currently points at — Colour showing exactly the list the
  // picked Style offers, not every colour in the database. watchedKey is a
  // stable string (not the field values directly) so the effect's own
  // dependency array stays a fixed length across renders.
  const watchedKey = fields
    .filter((f) => f.optionsFromField)
    .map((f) => String(values[f.optionsFromField!.field] ?? ''))
    .join('|')

  useEffect(() => {
    if (!open) return

    const dependentFields = fields.filter((f) => f.optionsFromField)
    if (dependentFields.length === 0) return

    let cancelled = false

    void Promise.all(
      dependentFields.map(async (f) => {
        const { field: watched, resource: r, arrayKey } = f.optionsFromField!
        const id = values[watched]
        if (!id || typeof id !== 'string') return [f.name, []] as const
        try {
          const res = (await masterResource<Record<string, unknown>>(r).get(id)) as Single<
            Record<string, unknown>
          >
          const arr = Array.isArray(res.data[arrayKey]) ? (res.data[arrayKey] as unknown[]) : []
          return [f.name, arr.map((v) => ({ value: String(v), label: String(v) }))] as const
        } catch {
          return [f.name, []] as const
        }
      }),
    ).then((entries) => {
      if (!cancelled) setFieldOptions((prev) => ({ ...prev, ...Object.fromEntries(entries) }))
    })

    return () => {
      cancelled = true
    }
    // watchedKey stands in for the actual watched values here on purpose —
    // see the comment above it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fields, watchedKey])

  // Escape closes, and the page behind must not scroll while the dialog is up.
  useEffect(() => {
    if (!open) return
    // Opened over another dialog, Escape is caught first and kept here, so it
    // closes this form and leaves the one underneath open.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Escape in an open dropdown list closes that list, not the form.
      if ((e.target as HTMLElement | null)?.closest?.('[data-radix-popper-content-wrapper]')) return
      if (stacked) {
        e.stopPropagation()
        e.stopImmediatePropagation()
      }
      onClose()
    }
    document.addEventListener('keydown', onKey, stacked)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, stacked)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose, stacked])

  if (!open) return null

  const optionsFor = (f: FormField) => {
    if (f.optionsFromField) return fieldOptions[f.name]
    if (f.suggestFrom) {
      const { valueKey, label } = f.suggestFrom
      return (remoteRows[f.name] ?? []).map((row) => ({ value: String(row[valueKey] ?? ''), label: label(row) }))
    }
    if (!f.optionsFrom) return f.options
    const rows = remoteRows[f.name]
    if (!rows) return undefined
    const { valueKey = 'id', labelKey = 'name', filter } = f.optionsFrom
    return rows
      .filter((row) => !filter || filter(row, values))
      .map((row) => ({
        value: String(row[valueKey] ?? ''),
        label: String(row[labelKey] ?? row[valueKey] ?? ''),
      }))
  }

  const set = (name: string, value: unknown) => {
    const field = fields.find((f) => f.name === name)
    const next = field?.uppercase && typeof value === 'string' ? value.toUpperCase() : value

    setValues((v) => {
      const updated = { ...v, [name]: next }
      for (const r of field?.resets ?? []) updated[r] = ''

      if (field?.fills && field.optionsFrom && typeof next === 'string' && next) {
        const { valueKey = 'id' } = field.optionsFrom
        const row = remoteRows[field.name]?.find((r) => String(r[valueKey]) === next)
        const value = row ? field.fills.from(row) : undefined
        const target = field.fills.field
        const current = updated[target]
        const untouched = current === '' || current == null || current === filledBy.current[target]
        if (value && untouched) {
          updated[target] = value
          filledBy.current[target] = value
        }
      }

      // One field can fill in another — a GSTIN gives the state code away, and
      // nobody should have to know that to get their tax right.
      if (field?.derives && typeof next === 'string') {
        const derived = field.derives.from(next)
        if (derived) updated[field.derives.field] = derived
      }

      // A field whose options depend on this one no longer has a valid
      // selection once this one changes — Colour must not keep a value from
      // whichever Style was picked before.
      for (const f of fields) {
        if (f.optionsFromField?.field === name) updated[f.name] = ''
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

      // A hidden field must be sent as an explicit null, not left out —
      // leaving it out would let the server keep whatever it held before the
      // field was hidden, which is exactly the stale value hiding it was
      // meant to clear.
      if (f.showIf && !f.showIf(values)) {
        payload[f.name] = null
        continue
      }

      const raw = values[f.name]
      const key = f.sendAs ?? f.name

      if (f.type === 'checkbox') {
        payload[key] = Boolean(raw)
        continue
      }

      if (raw === '' || raw === undefined || raw === null) {
        if (f.required && payload[key] === undefined) payload[key] = raw
        continue
      }

      if (f.type === 'number') {
        payload[key] = Number(raw)
      } else if (f.type === 'tags') {
        payload[key] = String(raw)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      } else {
        payload[key] = raw
      }
    }

    return payload
  }

  // Whether this form insists on a field, given what is in its list now.
  const insists = (f: FormField) =>
    f.mustFill === true || (f.mustFill === 'ifOptions' && (optionsFor(f)?.length ?? 0) > 0)

  /** The fields shown now whose number is out of its limits, with why. */
  const outOfRange = () =>
    visibleFields.flatMap((f) => {
      const problem = rangeProblem(f, values[f.name])
      return problem ? [[f, problem] as const] : []
    })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Opened from inside another form (a unit added from a purchase order's
    // new item), the submit would otherwise bubble up the React tree, through
    // the portal, and save that form as well.
    e.stopPropagation()

    const unfilled = fields.filter(
      (f) => !f.generated && insists(f) && (values[f.name] === '' || values[f.name] == null),
    )
    if (unfilled.length) {
      setFieldErrors(
        Object.fromEntries(
          unfilled.map((f) => [
            f.name,
            f.type === 'select' ? `Choose a ${f.label.toLowerCase()}` : `${f.label} is needed`,
          ]),
        ),
      )
      setFormError(
        `Could not save. Check ${unfilled.map((f) => f.label).join(', ')} — the problem is marked in red below.`,
      )
      bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }

    // Said here rather than sent: the server would refuse it anyway.
    const wrong = outOfRange()
    if (wrong.length) {
      setFieldErrors(Object.fromEntries(wrong.map(([f, problem]) => [f.name, problem])))
      setFormError(
        `Could not save. Check ${wrong.map(([f]) => f.label).join(', ')} — the problem is marked in red below.`,
      )
      bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }

    setSaving(true)
    setFormError(null)
    setFieldErrors({})

    try {
      const payload = buildPayload()
      if (isEdit && record) {
        await client.update(record.id, payload as Partial<T>)
      } else {
        const created = await client.create(payload as Partial<T>)
        const row = (created as { data?: T })?.data
        if (row && onCreated) onCreated(row)
      }
      onSaved()
      onClose()
    } catch (err) {
      if (err instanceof ApiError) {
        // The server names what it was sent, so an error on `categoryId` is put
        // under the first box that saves as it: Category.
        if (err.fieldErrors) {
          const onBoxes: Record<string, string> = {}
          for (const [key, message] of Object.entries(err.fieldErrors)) {
            const box = fields.find((f) => f.name === key || f.sendAs === key)
            onBoxes[box?.name ?? key] = message
          }
          setFieldErrors(onBoxes)
        }

        // Naming the fields matters. "Please correct the highlighted fields"
        // is useless when the offending one has scrolled out of sight.
        const named = err.fieldErrors
          ? Object.entries(err.fieldErrors)
              .filter(([, m]) => m)
              .map(([key]) => fields.find((f) => f.name === key || f.sendAs === key)?.label ?? key)
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

  // A generated code is shown in the title bar, next to the name of the form,
  // rather than as a greyed-out box taking a place in the grid. Before the
  // record exists there is nothing to show at all. A showIf field has nothing
  // to show until its own condition is met.
  const visibleFields = fields.filter((f) => !f.generated && (!f.showIf || f.showIf(values)))

  // The Active tick goes in the footer beside Save rather than in a panel: it
  // is about the whole record, and in a panel it took a row of its own.
  const activeField = visibleFields.find((f) => f.name === 'isActive' && f.type === 'checkbox')

  const sections = visibleFields.filter((f) => f !== activeField).reduce<Record<string, FormField[]>>((acc, f) => {
    const key = f.section ?? ''
    ;(acc[key] ??= []).push(f)
    return acc
  }, {})

  const HeaderIcon = RESOURCE_ICONS[resource] ?? Database
  const heading = isEdit ? `Edit ${title}` : `New ${title}`
  const code = isEdit ? (fields.find((f) => f.generated) ?? null) : null
  const codeValue = code ? String(values[code.name] ?? '') : ''

  const formId = `${uid}-form`
  const titleId = `${uid}-title`

  // A unit added from the item form joins the list here and is picked, as
  // though it had always been there.
  const added = (f: FormField, row: Record<string, unknown>) => {
    const { valueKey = 'id', labelKey = 'name' } = f.optionsFrom ?? {}
    setRemoteRows((prev) => ({
      ...prev,
      [f.name]: [...(prev[f.name] ?? []).filter((r) => r[valueKey] !== row[valueKey]), row].sort((a, b) =>
        String(a[labelKey] ?? '').localeCompare(String(b[labelKey] ?? '')),
      ),
    }))
    set(f.name, String(row[valueKey] ?? ''))
  }

  const saveButton = (
    <button type="submit" form={formId} className="btn-primary" disabled={saving}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
      {isEdit ? 'Save changes' : `Save ${sentenceCase(title)}`}
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
  const portal = createPortal(
    <div
      className={`fixed inset-0 ${stacked ? 'z-[90]' : 'z-50'} flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3`}
    >
      {/* Capped and centred. A master has a dozen fields, not an item table;
        stretched across a wide screen each box ran half the monitor long. */}
      <form
        id={formId}
        onSubmit={submit}
        noValidate
        // As tall as what it holds, up to the screen. A short master fills a
        // short card rather than a full-height one with a blank lower half.
        // One of a few fields, opened over another form, is narrower still.
        className={`glass-card po-form flex max-h-full w-full ${wide ? 'max-w-6xl' : stacked && fields.length <= 4 ? 'max-w-2xl' : 'max-w-5xl'} flex-col self-center overflow-hidden`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {/* Header: stays put while the body scrolls, so it is always clear what is being filled in. */}
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <HeaderIcon size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2
                id={titleId}
                className="text-foreground truncate text-xl font-semibold tracking-tight"
              >
                {heading}
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {isEdit
                  ? codeValue
                    ? `${codeValue} · changes apply to new documents from now on`
                    : 'Changes apply to new documents from now on'
                  : // Only masters with a code field get one made up, so "the code
                    // is given by the system" was wrong on every form without one.
                    'Nothing is saved until you press Save'}
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
              {/* Rows a little closer on the four-across forms, which hold the most. */}
              <div className={`grid grid-cols-1 gap-x-4 ${columns === 4 ? 'gap-y-2' : 'gap-y-3'} ${GRID[columns]}`}>
                {sectionFields.map((f) => (
                  <Field
                    key={f.name}
                    id={`${uid}-${f.name}`}
                    field={f}
                    value={values[f.name]}
                    error={fieldErrors[f.name]}
                    options={optionsFor(f)}
                    columns={columns}
                    starred={Boolean(f.required) || insists(f)}
                    onChange={(v) => set(f.name, v)}
                    onCreate={
                      f.createFrom && f.optionsFrom && can('masters', 'create')
                        ? (typed) => setAdding({ field: f, typed })
                        : undefined
                    }
                  />
                ))}
              </div>
            </Section>
          ))}
        </div>

        {/* Footer: always in reach, however long the form. */}
        <div className="border-border flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">
          {activeField && (
            <label className="text-foreground mr-auto flex cursor-pointer select-none items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 accent-teal-500"
                checked={Boolean(values[activeField.name])}
                onChange={(e) => set(activeField.name, e.target.checked)}
              />
              <span className="font-medium">Active</span>
              {activeField.placeholder && (
                <span className="text-muted-foreground hidden sm:inline">
                  · {sentenceCase(activeField.placeholder)}
                </span>
              )}
            </label>
          )}
          <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
            Cancel
          </button>
          {saveButton}
        </div>
      </form>
    </div>,
    document.body,
  )

  if (!adding?.field.createFrom || !adding.field.optionsFrom) return portal
  const { field: addingTo, typed } = adding
  const { fields: newFields, title: newTitle, typedInto = 'name' } = addingTo.createFrom!

  // Beside this form's portal, not inside its <form>: a submit inside a
  // portal still bubbles up the React tree, and would save this form too.
  return (
    <>
      {portal}
      <MasterFormDialog<{ id: string } & Record<string, unknown>>
        open
        onClose={() => setAdding(null)}
        onSaved={() => {}}
        onCreated={(row) => added(addingTo, row)}
        resource={addingTo.optionsFrom!.resource}
        fields={newFields}
        initialValues={typed ? { [typedInto]: typed } : undefined}
        title={newTitle}
        stacked
      />
    </>
  )
}

function Field({
  id,
  field,
  value,
  error,
  options,
  columns,
  starred,
  onChange,
  onCreate,
}: {
  /** The box's id, unique on the page even with a second form open over this one. */
  id: string
  field: FormField
  value: unknown
  error?: string
  options?: { value: string; label: string }[]
  columns: 3 | 4
  /** Shows the red asterisk: required by the API, or by this form. */
  starred: boolean
  onChange: (v: unknown) => void
  /** Adds a missing choice from inside the list (see createFrom). */
  onCreate?: (typed: string) => void
}) {
  const type = field.type ?? 'text'
  // A description or an address is read as a paragraph, so it takes the whole
  // row; a two-wide field takes two of the three columns.
  const wrapper = `min-w-0 ${
    field.span ? SPAN[columns][field.span] : type === 'textarea' ? 'col-span-full' : ''
  }`
  // Out of its limits is said as it is typed, not only on Save.
  const problem = error || rangeProblem(field, value)
  const invalid = Boolean(problem)
  const noMinus = type === 'number' && !field.allowNegative && (field.min ?? 0) >= 0
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
        <label className="form-label" htmlFor={id}>
          {field.label}
        </label>
        <input
          id={id}
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
      <label className="form-label" htmlFor={id}>
        {field.label}
        {starred && <span className="text-red-400 ml-0.5">*</span>}
      </label>

      {type === 'textarea' && (
        <textarea
          id={id}
          rows={field.rows ?? 2}
          className={inputClass}
          placeholder={hint}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {type === 'select' && (
        <SmartSelect
          id={id}
          className={inputClass}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          onCreate={onCreate}
          createNoun={field.createFrom?.noun}
        >
          <option value="">
            {field.optionsFrom && !options
              ? 'Loading...'
              : options?.length === 0 && field.emptyLabel
                ? field.emptyLabel
                : 'Select...'}
          </option>
          {options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SmartSelect>
      )}

      {/* Boxed at the same height as the fields beside it, so a tick box
        lines up with its row instead of floating under its label. */}
      {type === 'checkbox' && (
        <label className="form-readout text-foreground h-[2.625rem] cursor-pointer select-none items-center">
          <input
            id={id}
            type="checkbox"
            className="h-4 w-4 shrink-0 accent-teal-500"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="min-w-0 truncate">{field.placeholder ?? 'Yes'}</span>
        </label>
      )}

      {field.suggestFrom && type === 'text' ? (
        <SuggestInput
          id={id}
          className={inputClass}
          placeholder={hint}
          value={String(value ?? '')}
          onValueChange={(v) => onChange(v)}
          suggestions={(options ?? []).map((o) => ({ value: o.value, label: o.label }))}
        />
      ) : (
        (type === 'text' || type === 'number' || type === 'date' || type === 'tags') && (
          <input
            id={id}
            type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
            step={type === 'number' ? 'any' : undefined}
            min={type === 'number' ? (field.min ?? (field.allowNegative ? undefined : 0)) : undefined}
            max={type === 'number' ? field.max : undefined}
            className={inputClass}
            placeholder={hint}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            // The minus key does nothing where a number cannot be negative.
            onKeyDown={noMinus ? (e) => e.key === '-' && e.preventDefault() : undefined}
          />
        )
      )}

      {problem ? (
        <p className="form-help !text-red-400">{problem}</p>
      ) : (field.liveHelp?.(value) ?? field.help) ? (
        <p className="form-help">{field.liveHelp?.(value) ?? field.help}</p>
      ) : null}
    </div>
  )
}

/** Why a number box's value is outside its limits, or null when it is fine. */
function rangeProblem(f: FormField, value: unknown): string | null {
  if (f.type !== 'number' || value === '' || value == null) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return `${f.label} has to be a number`
  const min = f.min ?? (f.allowNegative ? undefined : 0)
  if (min !== undefined && n < min) {
    return min === 0 ? `${f.label} cannot be negative` : `${f.label} cannot be less than ${min}`
  }
  if (f.max !== undefined && n > f.max) return `${f.label} cannot be more than ${f.max}`
  return null
}

/** "HSN / SAC Code" → "HSN / SAC code": lower case, but an abbreviation keeps its capitals. */
function sentenceCase(title: string): string {
  return title
    .split(' ')
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()))
    .join(' ')
}
