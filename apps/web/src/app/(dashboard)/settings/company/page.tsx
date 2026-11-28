'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Plus, Pencil, X, Check, Ban, Building2, Hash, Percent, Receipt, Landmark, MapPin, Tag, CalendarDays } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { loadAppSettings } from '@/lib/appSettings'
import { cn } from '@/lib/utils'
import {
  settingsApi,
  type Company,
  type NumberSeries,
  type TaxRate,
} from '@/lib/settingsApi'
import { Field, FieldGrid, LoadingRow, Notice, SaveBar, SaveButton, SettingsCard, Toggle } from '@/components/settings/ui'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { TdsSections } from '@/components/settings/TdsSections'
import { SectionHeader } from '@/components/settings/sections'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "2425" reads as nothing; "April 2024 – March 2025" reads as a year. */
function describeFY(fy: string | null, startMonth: number): string {
  if (!fy || !/^\d{4}$/.test(fy)) return 'Not set'
  const from = 2000 + Number(fy.slice(0, 2))
  const to = 2000 + Number(fy.slice(2))
  const endMonth = ((startMonth + 10) % 12) + 1
  return `${MONTHS[startMonth - 1]} ${from} – ${MONTHS[endMonth - 1]} ${to}`
}

/**
 * The four parts of this page, one at a time.
 *
 * They were stacked, and reaching TDS at the bottom meant scrolling past the
 * whole company profile and every number series first. The open tab is in the
 * address (`?tab=tds`), so a link can land on the right one and a refresh
 * stays put.
 */
const SECTIONS = [
  { key: 'profile', label: 'Company Profile', icon: Building2 },
  { key: 'numbering', label: 'Running Series', icon: Hash },
  { key: 'gst', label: 'GST Rates', icon: Percent },
  { key: 'tds', label: 'TDS Sections', icon: Receipt },
] as const

type SectionKey = (typeof SECTIONS)[number]['key']

function CompanySettings() {
  const router = useRouter()
  const params = useSearchParams()
  const current: SectionKey = SECTIONS.find((s) => s.key === params.get('tab'))?.key ?? 'profile'

  const open = (key: SectionKey) =>
    router.replace(key === 'profile' ? '/settings/company' : `/settings/company?tab=${key}`, {
      scroll: false,
    })

  return (
    <div className="space-y-5">
      <SectionHeader
        below={
      <div
        role="tablist"
        aria-label="Company settings"
        className="border-border bg-card no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-xl border p-1 shadow-sm"
      >
        {SECTIONS.map((s) => {
          const Icon = s.icon
          const on = s.key === current
          return (
            <button
              key={s.key}
              type="button"
              role="tab"
              id={`company-tab-${s.key}`}
              aria-selected={on}
              aria-controls={`company-panel-${s.key}`}
              onClick={() => open(s.key)}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors',
                on
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              )}
            >
              <Icon size={15} />
              {s.label}
            </button>
          )
        })}
      </div>
        }
      />

      {/* All four stay mounted and only the open one shows, so a half-typed
        company profile survives a look at the GST rates. */}
      {SECTIONS.map((s) => (
        <div
          key={s.key}
          role="tabpanel"
          id={`company-panel-${s.key}`}
          aria-labelledby={`company-tab-${s.key}`}
          hidden={s.key !== current}
        >
          {s.key === 'profile' && <CompanyProfile />}
          {s.key === 'numbering' && <DocumentNumbering />}
          {s.key === 'gst' && <TaxRates />}
          {s.key === 'tds' && <TdsSections />}
        </div>
      ))}
    </div>
  )
}

export default function CompanySettingsPage() {
  // useSearchParams needs a Suspense boundary or the route opts out of static rendering.
  return (
    <Suspense fallback={<LoadingRow />}>
      <CompanySettings />
    </Suspense>
  )
}

// ── Company profile ──────────────────────────────────────────────────────────

/**
 * Sizes still carrying store barcodes once the GS1 prefix is saved: changed
 * to GS1 ones in one press. Shows nothing while there are none.
 */
function StoreBarcodes({ gs1Prefix }: { gs1Prefix: string | null | undefined }) {
  const [count, setCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: { count: number } }>('/retail/store-barcodes')
      setCount(res.data.count)
    } catch {
      setCount(0)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, gs1Prefix])

  const change = async () => {
    const what = count === 1 ? '1 store barcode' : `${count} store barcodes`
    if (!confirm(`Change ${what} to GS1 ones? Tags already printed carry the old numbers and will need printing again.`)) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await api.post<{ message: string }>('/retail/store-barcodes/to-gs1', {})
      setMessage({ kind: 'success', text: res.message })
      await load()
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not change the barcodes.' })
    } finally {
      setBusy(false)
    }
  }

  if (!count) return message ? <Notice kind={message.kind}>{message.text}</Notice> : null
  const sizes = count === 1 ? '1 size has a store barcode' : `${count} sizes have store barcodes`
  return (
    <div className="space-y-2">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary px-3 py-2 text-sm">
        <span>
          {sizes} <span className="text-muted-foreground">(starting 200).</span>
          {!gs1Prefix && <span className="text-muted-foreground"> Save your GS1 prefix to change them to GS1 ones.</span>}
        </span>
        {gs1Prefix && (
          <button type="button" className="btn-primary h-9" onClick={() => void change()} disabled={busy}>
            {busy ? 'Changing…' : 'Change to GS1 barcodes'}
          </button>
        )}
      </div>
    </div>
  )
}

function CompanyProfile() {
  const [company, setCompany] = useState<Company | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await settingsApi.company.get()
      setCompany(res.data)
      setValues(
        Object.fromEntries(
          Object.entries(res.data).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]),
        ),
      )
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not load the company profile.',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const set = (key: string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }))
    setErrors((e) => (e[key] ? { ...e, [key]: '' } : e))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!company) return

    setSaving(true)
    setErrors({})
    setMessage(null)

    // Blank optional fields are sent as null so clearing one actually clears it;
    // sending "" would fail the GSTIN and email formats.
    const payload: Record<string, unknown> = {}
    const editable = [
      'name', 'legalName', 'gstin', 'stateCode', 'pan', 'tan', 'msmeNumber',
      'phone', 'email', 'website',
      'address', 'address2', 'city', 'state', 'pincode', 'currentFY',
      'gs1Prefix', 'countryOfOrigin', 'customerCare',
    ]
    for (const key of editable) {
      const raw = (values[key] ?? '').trim()
      payload[key] = raw === '' ? null : raw
    }
    payload.name = (values.name ?? '').trim()
    payload.fyStartMonth = Number(values.fyStartMonth) || 4
    payload.booksStartDate = (values.booksStartDate ?? '').trim() || null

    try {
      const res = await settingsApi.company.update(payload as Partial<Company>)
      setCompany(res.data)
      // The menu shows the company's name, so it is told straight away.
      await loadAppSettings(true)
      setMessage({ kind: 'success', text: 'Company details saved.' })
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fieldErrors) setErrors(err.fieldErrors)
        setMessage({
          kind: 'error',
          text: err.fieldErrors ? 'Please correct the highlighted fields.' : err.message,
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
      <SettingsCard title="Company details" icon={Building2}>
        <LoadingRow />
      </SettingsCard>
    )
  }

  const startMonth = Number(values.fyStartMonth) || 4

  /** A text box for one company field. */
  const text = (key: string, opts: { mono?: boolean; placeholder?: string; upper?: boolean; digits?: boolean; maxLength?: number; type?: string } = {}) => (
    <input
      id={key}
      type={opts.type ?? 'text'}
      className={cn('form-input', opts.mono && 'font-mono')}
      placeholder={opts.placeholder}
      maxLength={opts.maxLength}
      inputMode={opts.digits ? 'numeric' : undefined}
      value={values[key] ?? ''}
      onChange={(e) => {
        let v = e.target.value
        if (opts.upper) v = v.toUpperCase()
        if (opts.digits) v = v.replace(/\D/g, '')
        set(key, v)
      }}
    />
  )

  return (
    <form onSubmit={submit} className="space-y-5">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      <SettingsCard
        icon={Building2}
        title="Business identity"
        description="The names printed at the head of every invoice, challan and purchase order."
      >
        <FieldGrid>
          <Field label="Company name" htmlFor="name" required error={errors.name} help="The trading name, as people know you">
            {text('name')}
          </Field>
          <Field label="Legal name" htmlFor="legalName" error={errors.legalName} help="As registered, if different from the trading name">
            {text('legalName')}
          </Field>
          <Field label="Website" htmlFor="website" error={errors.website}>
            {text('website', { placeholder: 'https://ldcottonmills.com' })}
          </Field>
        </FieldGrid>
      </SettingsCard>

      <SettingsCard
        icon={Landmark}
        title="Tax registration"
        description="GST, income-tax and MSME numbers, printed on documents and used to work out the tax."
      >
        <FieldGrid>
          <Field label="GSTIN" htmlFor="gstin" error={errors.gstin} help="15 characters">
            <input
              id="gstin"
              className="form-input font-mono"
              placeholder="27AAFFL6946D1Z7"
              maxLength={15}
              value={values.gstin ?? ''}
              onChange={(e) => {
                const gstin = e.target.value.toUpperCase()
                set('gstin', gstin)
                // The first two digits are the state code. Filling it in here
                // is what decides CGST+SGST versus IGST on every invoice, and
                // nobody should have to know that to get their tax right.
                if (/^\d{2}/.test(gstin)) set('stateCode', gstin.slice(0, 2))
              }}
            />
          </Field>
          <Field
            label="GST state code"
            htmlFor="stateCode"
            error={errors.stateCode}
            help="Taken from your GSTIN. Decides whether a sale is CGST+SGST or IGST."
          >
            {text('stateCode', { mono: true, placeholder: '27', digits: true, maxLength: 2 })}
          </Field>
          <Field label="PAN" htmlFor="pan" error={errors.pan}>
            {text('pan', { mono: true, placeholder: 'AAFFL6946D', upper: true, maxLength: 10 })}
          </Field>
          <Field label="TAN" htmlFor="tan" error={errors.tan} help="Needed to deduct TDS and issue Form 16A to contractors">
            {text('tan', { mono: true, placeholder: 'PNEL06861B', upper: true, maxLength: 10 })}
          </Field>
          <Field
            label="MSME / Udyam number"
            htmlFor="msmeNumber"
            error={errors.msmeNumber}
            help="Optional. Registered suppliers must be paid within 45 days by law."
          >
            {text('msmeNumber', { mono: true, placeholder: 'UDYAM-MH-00-0000000', upper: true })}
          </Field>
        </FieldGrid>
      </SettingsCard>

      <SettingsCard icon={MapPin} title="Address and contact" description="Where you are and how customers and suppliers reach you.">
        <FieldGrid>
          <Field label="Address" htmlFor="address" error={errors.address} span={3}>
            <textarea
              id="address"
              rows={2}
              className="form-input"
              value={values.address ?? ''}
              onChange={(e) => set('address', e.target.value)}
            />
          </Field>
          <Field
            label="Address 2 / HO"
            htmlFor="address2"
            error={errors.address2}
            span={3}
            help="Optional. The head office, or a second unit, when it is not the address above."
          >
            <textarea
              id="address2"
              rows={2}
              className="form-input"
              value={values.address2 ?? ''}
              onChange={(e) => set('address2', e.target.value)}
            />
          </Field>
          <Field label="City" htmlFor="city" error={errors.city}>
            {text('city')}
          </Field>
          <Field label="State" htmlFor="state" error={errors.state}>
            {text('state')}
          </Field>
          <Field label="PIN code" htmlFor="pincode" error={errors.pincode}>
            {text('pincode', { mono: true, placeholder: '421302', digits: true, maxLength: 6 })}
          </Field>
          <Field label="Phone" htmlFor="phone" error={errors.phone}>
            {text('phone', { type: 'tel' })}
          </Field>
          <Field label="Email" htmlFor="email" error={errors.email} span={2}>
            {text('email', { type: 'email' })}
          </Field>
        </FieldGrid>
      </SettingsCard>

      {/* What a garment's retail tag carries from the company. */}
      <SettingsCard
        icon={Tag}
        title="Retail labels"
        description="EAN-13 barcodes on retail tags are built from the GS1 prefix. Without one, tags get store barcodes starting 200: they scan at your own counter, but outside shops and marketplaces need GS1 ones."
      >
        <div className="space-y-4">
          <FieldGrid>
            <Field
              label="GS1 company prefix"
              htmlFor="gs1Prefix"
              error={errors.gs1Prefix}
              help="7 to 10 digits, from the GS1 India certificate. Leave empty until you have it"
            >
              {text('gs1Prefix', { mono: true, placeholder: 'e.g. 8901234', digits: true, maxLength: 10 })}
            </Field>
            <Field label="Country of origin" htmlFor="countryOfOrigin" error={errors.countryOfOrigin}>
              {text('countryOfOrigin', { placeholder: 'India' })}
            </Field>
            <Field
              label="Customer care"
              htmlFor="customerCare"
              error={errors.customerCare}
              help="Printed on retail tags. Empty: the phone and email above"
            >
              {text('customerCare', { placeholder: 'care@ldcottonmills.com · +91 98765 43210' })}
            </Field>
          </FieldGrid>
          <StoreBarcodes gs1Prefix={company?.gs1Prefix} />
        </div>
      </SettingsCard>

      <SettingsCard
        icon={CalendarDays}
        title="Financial year"
        description="Document numbers are counted per financial year, so this decides when the counters start again from one."
      >
        <FieldGrid>
          <Field
            label="Current financial year"
            htmlFor="currentFY"
            error={errors.currentFY}
            help={describeFY(values.currentFY || null, startMonth)}
          >
            {text('currentFY', { mono: true, placeholder: '2425', digits: true, maxLength: 4 })}
          </Field>
          <Field label="Year starts in" htmlFor="fyStartMonth" error={errors.fyStartMonth}>
            <SmartSelect
              id="fyStartMonth"
              className="form-input"
              value={String(startMonth)}
              onChange={(e) => set('fyStartMonth', e.target.value)}
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </SmartSelect>
          </Field>
          <Field
            label="Books start from"
            htmlFor="booksStartDate"
            error={errors.booksStartDate}
            help="Nothing can be dated before this. Set it to the day you start using the ERP."
          >
            <input
              id="booksStartDate"
              type="date"
              className="form-input"
              value={(values.booksStartDate ?? '').slice(0, 10)}
              onChange={(e) => set('booksStartDate', e.target.value)}
            />
          </Field>
        </FieldGrid>
      </SettingsCard>

      <SaveBar saving={saving} note="Printed on every document from the next one you make." />
    </form>
  )
}

// ── Document numbering ───────────────────────────────────────────────────────

/** The number a series would print for `n`, the same way the server writes it (empty parts left out). */
function seriesNumber(s: Pick<NumberSeries, 'prefix' | 'separator' | 'financialYear' | 'padding'>, n: number) {
  return [s.prefix, s.financialYear, String(n).padStart(s.padding, '0')].filter(Boolean).join(s.separator)
}

/**
 * The current running series (27 Nov 2026): for every document, the last
 * number given out and the next one. A user who may edit settings can set
 * where a series carries on from — ahead to skip numbers, or back to start
 * again — and the server refuses any number already on a document.
 */
function DocumentNumbering() {
  const mayEdit = can('settings', 'edit')
  const [nextEdit, setNextEdit] = useState<{ id: string; value: string; error: string | null } | null>(null)
  const [series, setSeries] = useState<NumberSeries[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ prefix: string; separator: string; padding: string }>({
    prefix: '',
    separator: '-',
    padding: '4',
  })
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await settingsApi.numberSeries.list()
      setSeries(res.data)
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not load document numbering.',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const startEdit = (s: NumberSeries) => {
    setNextEdit(null)
    setEditingId(s.id)
    setDraft({ prefix: s.prefix, separator: s.separator, padding: String(s.padding) })
    setMessage(null)
  }

  const save = async (s: NumberSeries) => {
    setBusy(true)
    setMessage(null)
    try {
      const res = await settingsApi.numberSeries.update(s.id, {
        prefix: draft.prefix.trim(),
        separator: draft.separator,
        padding: Number(draft.padding),
      })
      setSeries((rows) => rows.map((r) => (r.id === s.id ? { ...r, ...res.data } : r)))
      setEditingId(null)
      setMessage({ kind: 'success', text: res.message ?? `${s.label} numbering updated.` })
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not save.',
      })
    } finally {
      setBusy(false)
    }
  }

  const startNext = (s: NumberSeries) => {
    setEditingId(null)
    setNextEdit({ id: s.id, value: String(s.lastNumber + 1), error: null })
    setMessage(null)
  }

  const saveNext = async (s: NumberSeries) => {
    if (!nextEdit) return
    const n = Number(nextEdit.value)
    if (!nextEdit.value.trim() || !Number.isInteger(n) || n < 1) {
      setNextEdit({ ...nextEdit, error: 'Type the number to carry on from — 1 or more.' })
      return
    }
    setBusy(true)
    try {
      const res = await settingsApi.numberSeries.setNext(s.id, n)
      setSeries((rows) => rows.map((r) => (r.id === s.id ? { ...r, ...res.data } : r)))
      setNextEdit(null)
      setMessage({ kind: 'success', text: res.message ?? `The next ${s.label.toLowerCase()} will be ${res.data.nextNumber}.` })
    } catch (err) {
      setNextEdit({ ...nextEdit, error: err instanceof ApiError ? err.message : 'Could not save.' })
    } finally {
      setBusy(false)
    }
  }

  const toggleActive = async (s: NumberSeries) => {
    setBusy(true)
    try {
      const res = await settingsApi.numberSeries.update(s.id, { isActive: !s.isActive })
      setSeries((rows) => rows.map((r) => (r.id === s.id ? { ...r, ...res.data } : r)))
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard
      icon={Hash}
      title="Current running series"
      description="How each document is numbered, the last number it has used, and the number the next one will take."
    >
      {message && (
        <div className="mb-4">
          <Notice kind={message.kind}>{message.text}</Notice>
        </div>
      )}

      {loading ? (
        <LoadingRow />
      ) : series.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          No numbering set up yet. Seed the database to create the standard series.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Document</th>
                <th>Prefix</th>
                <th>Between</th>
                <th style={{ textAlign: "right" }}>Digits</th>
                <th>Last used</th>
                <th>Next number</th>
                <th style={{ textAlign: "center" }}>In use</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {series.map((s) => {
                const isEditing = editingId === s.id
                const settingNext = nextEdit?.id === s.id ? nextEdit : null
                const preview = isEditing
                  ? seriesNumber(
                      {
                        prefix: draft.prefix || s.prefix,
                        separator: draft.separator,
                        financialYear: s.financialYear,
                        padding: Number(draft.padding) || s.padding,
                      },
                      s.lastNumber + 1,
                    )
                  : s.nextNumber
                const typedNext = settingNext ? Number(settingNext.value) : NaN

                return (
                  <tr key={s.id}>
                    <td className="font-medium">
                      {s.label}
                      <span className="text-xs text-muted-foreground ml-2 font-mono">{s.docType}</span>
                    </td>
                    <td>
                      {isEditing ? (
                        <input
                          className="form-input h-8 w-24 font-mono"
                          value={draft.prefix}
                          onChange={(e) => setDraft((d) => ({ ...d, prefix: e.target.value.toUpperCase() }))}
                          aria-label={`${s.label} prefix`}
                        />
                      ) : (
                        <span className="font-mono font-semibold text-primary">{s.prefix}</span>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <SmartSelect
                          className="form-input h-8 w-20"
                          value={draft.separator}
                          onChange={(e) => setDraft((d) => ({ ...d, separator: e.target.value }))}
                          aria-label={`${s.label} separator`}
                        >
                          <option value="-">dash</option>
                          <option value="/">slash</option>
                          <option value="">nothing</option>
                        </SmartSelect>
                      ) : (
                        <span className="font-mono text-muted-foreground">{s.separator || 'none'}</span>
                      )}
                    </td>
                    <td className="text-right">
                      {isEditing ? (
                        <input
                          type="number"
                          min={1}
                          max={8}
                          className="form-input h-8 w-16 text-right"
                          value={draft.padding}
                          onChange={(e) => setDraft((d) => ({ ...d, padding: e.target.value }))}
                          aria-label={`${s.label} digits`}
                        />
                      ) : (
                        s.padding
                      )}
                    </td>
                    <td className="font-mono text-xs whitespace-nowrap">
                      {s.lastUsedNumber ??<span className="font-sans text-muted-foreground">None yet</span>}
                    </td>
                    <td className="text-xs">
                      {settingNext ? (
                        <div className="space-y-1">
                          <div className="flex items-center gap-1">
                            <StepInput
                              className="form-input h-8 w-24 text-right"
                              min={1}
                              value={settingNext.value}
                              onValueChange={(value) => setNextEdit({ ...settingNext, value, error: null })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void saveNext(s)
                                if (e.key === 'Escape') setNextEdit(null)
                              }}
                              autoFocus
                              aria-label={`${s.label} next number`}
                            />
                            <button
                              className="btn-ghost p-1.5 text-emerald-400"
                              onClick={() => void saveNext(s)}
                              disabled={busy}
                              title="Save"
                              aria-label={`Save ${s.label} next number`}
                            >
                              <Check size={15} />
                            </button>
                            <button
                              className="btn-ghost p-1.5"
                              onClick={() => setNextEdit(null)}
                              disabled={busy}
                              title="Cancel"
                              aria-label="Cancel"
                            >
                              <X size={15} />
                            </button>
                          </div>
                          {Number.isInteger(typedNext) && typedNext >= 1 && (
                            <p className="text-muted-foreground">
                              Next will be <span className="font-mono text-foreground">{seriesNumber(s, typedNext)}</span>
                            </p>
                          )}
                          {settingNext.error && <p className="max-w-xs text-red-500">{settingNext.error}</p>}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 whitespace-nowrap">
                          <span className="font-mono">{preview}</span>
                          {mayEdit && !isEditing && (
                            <button
                              className="text-primary text-xs hover:underline"
                              onClick={() => startNext(s)}
                              aria-label={`Set the next ${s.label} number`}
                            >
                              Set
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="text-center">
                      <div className="flex justify-center">
                        <Toggle
                          checked={s.isActive}
                          onChange={() => void toggleActive(s)}
                          label={`${s.label} numbering in use`}
                          disabled={busy}
                        />
                      </div>
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {isEditing ? (
                        <div className="flex justify-end gap-1">
                          <button
                            className="btn-ghost p-1.5 text-emerald-400"
                            onClick={() => void save(s)}
                            disabled={busy}
                            title="Save"
                            aria-label={`Save ${s.label} numbering`}
                          >
                            <Check size={15} />
                          </button>
                          <button
                            className="btn-ghost p-1.5"
                            onClick={() => setEditingId(null)}
                            disabled={busy}
                            title="Cancel"
                            aria-label="Cancel"
                          >
                            <X size={15} />
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn-ghost p-1.5"
                          onClick={() => startEdit(s)}
                          title="Change"
                          aria-label={`Change ${s.label} numbering`}
                        >
                          <Pencil size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-4">
        Deleting the newest document of a series gives its number back, so the next one takes it again.
        Deleting one in the middle leaves a gap. <span className="font-medium">Set</span> moves where a
        series carries on from — ahead to skip numbers, or back to start again — but never to a number
        already on a document. Documents already made keep the numbers they were given.
      </p>
    </SettingsCard>
  )
}

// ── GST rates ────────────────────────────────────────────────────────────────

function TaxRates() {
  const [rates, setRates] = useState<TaxRate[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: '', rate: '' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await settingsApi.taxRates.list()
      setRates(res.data)
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not load GST rates.',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await settingsApi.taxRates.create({
        name: draft.name.trim(),
        rate: Number(draft.rate),
      })
      setDraft({ name: '', rate: '' })
      setAdding(false)
      await load()
      setMessage({ kind: 'success', text: 'Rate added.' })
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not add the rate.' })
    } finally {
      setBusy(false)
    }
  }

  const makeDefault = async (r: TaxRate) => {
    setBusy(true)
    try {
      await settingsApi.taxRates.update(r.id, { isDefault: true })
      await load()
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save.' })
    } finally {
      setBusy(false)
    }
  }

  const retire = async (r: TaxRate) => {
    if (!confirm(`Stop offering ${r.name} on new documents? Existing documents keep it.`)) return
    setBusy(true)
    try {
      const res = await settingsApi.taxRates.remove(r.id)
      await load()
      setMessage({ kind: 'success', text: res.message })
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save.' })
    } finally {
      setBusy(false)
    }
  }

  const active = rates.filter((r) => r.isActive)
  const retired = rates.filter((r) => !r.isActive)

  return (
    <SettingsCard
      icon={Percent}
      title="GST rates"
      description="The rates offered when a document is priced, so nobody types a percentage by hand."
      actions={
        !adding && (
          <button className="btn-secondary text-xs" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add rate
          </button>
        )
      }
    >
      {message && (
        <div className="mb-4">
          <Notice kind={message.kind}>{message.text}</Notice>
        </div>
      )}

      {adding && (
        <form onSubmit={add} className="mb-5 p-4 rounded-lg border border-border bg-secondary/40">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <Field label="Name" htmlFor="rate-name" required>
              <input
                id="rate-name"
                className="form-input"
                placeholder="GST 12%"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </Field>
            <Field label="Rate (%)" htmlFor="rate-value" required>
              <input
                id="rate-value"
                type="number"
                step="0.01"
                min={0}
                max={100}
                className="form-input"
                placeholder="12"
                value={draft.rate}
                onChange={(e) => setDraft((d) => ({ ...d, rate: e.target.value }))}
              />
            </Field>
            <div className="flex gap-2">
              <SaveButton saving={busy} disabled={!draft.name.trim() || draft.rate === ''}>
                Add
              </SaveButton>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setAdding(false)
                  setDraft({ name: '', rate: '' })
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      )}

      {loading ? (
        <LoadingRow />
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No rates yet. Add the ones you charge.</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {active.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-secondary/30"
            >
              <div>
                <p className="text-sm font-medium text-foreground">{r.name}</p>
                <p className="text-xs text-muted-foreground">{r.rate}%</p>
              </div>

              {r.isDefault ? (
                <span className="badge-info">Default</span>
              ) : (
                <button
                  className="text-xs text-muted-foreground hover:text-primary transition-colors"
                  onClick={() => void makeDefault(r)}
                  disabled={busy}
                >
                  Make default
                </button>
              )}

              <button
                className="btn-ghost p-1.5 text-muted-foreground hover:text-red-400"
                onClick={() => void retire(r)}
                disabled={busy}
                title="Stop offering this rate"
                aria-label={`Stop offering ${r.name}`}
              >
                <Ban size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {retired.length > 0 && (
        <p className="text-xs text-muted-foreground mt-4">
          No longer offered: {retired.map((r) => r.name).join(', ')}
        </p>
      )}
    </SettingsCard>
  )
}
