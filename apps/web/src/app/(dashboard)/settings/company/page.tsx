'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, X, Check, Ban } from 'lucide-react'
import { ApiError } from '@/lib/api'
import {
  settingsApi,
  type Company,
  type NumberSeries,
  type TaxRate,
} from '@/lib/settingsApi'
import { Field, LoadingRow, Notice, SaveButton, SettingsCard, Toggle } from '@/components/settings/ui'

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

export default function CompanySettingsPage() {
  return (
    <div className="space-y-6">
      <CompanyProfile />
      <DocumentNumbering />
      <TaxRates />
    </div>
  )
}

// ── Company profile ──────────────────────────────────────────────────────────

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
      'address', 'city', 'state', 'pincode', 'currentFY',
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
      <SettingsCard title="Company details">
        <LoadingRow />
      </SettingsCard>
    )
  }

  const startMonth = Number(values.fyStartMonth) || 4

  return (
    <SettingsCard
      title="Company details"
      description="Printed on every invoice, challan and purchase order."
    >
      <form onSubmit={submit} className="space-y-6">
        {message && <Notice kind={message.kind}>{message.text}</Notice>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Company name" htmlFor="name" required error={errors.name} span={2}>
            <input
              id="name"
              className="form-input"
              value={values.name ?? ''}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>

          <Field
            label="Legal name"
            htmlFor="legalName"
            error={errors.legalName}
            help="As registered, if different from the trading name"
            span={2}
          >
            <input
              id="legalName"
              className="form-input"
              value={values.legalName ?? ''}
              onChange={(e) => set('legalName', e.target.value)}
            />
          </Field>

          <Field label="GSTIN" htmlFor="gstin" error={errors.gstin} help="15 characters">
            <input
              id="gstin"
              className="form-input font-mono"
              placeholder="27AAFFL6946D1Z7"
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
            label="GST State Code"
            htmlFor="stateCode"
            error={errors.stateCode}
            help="Taken from your GSTIN. This decides whether a sale is taxed CGST+SGST or IGST."
          >
            <input
              id="stateCode"
              className="form-input font-mono"
              placeholder="27"
              maxLength={2}
              value={values.stateCode ?? ''}
              onChange={(e) => set('stateCode', e.target.value.replace(/\D/g, ''))}
            />
          </Field>

          <Field label="PAN" htmlFor="pan" error={errors.pan}>
            <input
              id="pan"
              className="form-input font-mono"
              placeholder="AAFFL6946D"
              value={values.pan ?? ''}
              onChange={(e) => set('pan', e.target.value.toUpperCase())}
            />
          </Field>

          <Field
            label="TAN"
            htmlFor="tan"
            error={errors.tan}
            help="Needed to deduct TDS and to issue Form 16A to your contractors"
          >
            <input
              id="tan"
              className="form-input font-mono"
              placeholder="PNEL06861B"
              value={values.tan ?? ''}
              onChange={(e) => set('tan', e.target.value.toUpperCase())}
            />
          </Field>

          <Field
            label="MSME / Udyam Number"
            htmlFor="msmeNumber"
            error={errors.msmeNumber}
            help="Optional. Registered suppliers must be paid within 45 days by law."
          >
            <input
              id="msmeNumber"
              className="form-input font-mono"
              placeholder="UDYAM-MH-00-0000000"
              value={values.msmeNumber ?? ''}
              onChange={(e) => set('msmeNumber', e.target.value.toUpperCase())}
            />
          </Field>

          <Field label="Phone" htmlFor="phone" error={errors.phone}>
            <input
              id="phone"
              className="form-input"
              value={values.phone ?? ''}
              onChange={(e) => set('phone', e.target.value)}
            />
          </Field>

          <Field label="Email" htmlFor="email" error={errors.email}>
            <input
              id="email"
              className="form-input"
              value={values.email ?? ''}
              onChange={(e) => set('email', e.target.value)}
            />
          </Field>

          <Field label="Website" htmlFor="website" error={errors.website} span={2}>
            <input
              id="website"
              className="form-input"
              placeholder="https://ldcottonmills.com"
              value={values.website ?? ''}
              onChange={(e) => set('website', e.target.value)}
            />
          </Field>

          <Field label="Address" htmlFor="address" error={errors.address} span={2}>
            <textarea
              id="address"
              rows={2}
              className="form-input"
              value={values.address ?? ''}
              onChange={(e) => set('address', e.target.value)}
            />
          </Field>

          <Field label="City" htmlFor="city" error={errors.city}>
            <input
              id="city"
              className="form-input"
              value={values.city ?? ''}
              onChange={(e) => set('city', e.target.value)}
            />
          </Field>

          <Field label="State" htmlFor="state" error={errors.state}>
            <input
              id="state"
              className="form-input"
              value={values.state ?? ''}
              onChange={(e) => set('state', e.target.value)}
            />
          </Field>

          <Field label="PIN code" htmlFor="pincode" error={errors.pincode}>
            <input
              id="pincode"
              className="form-input font-mono"
              placeholder="395010"
              value={values.pincode ?? ''}
              onChange={(e) => set('pincode', e.target.value)}
            />
          </Field>
        </div>

        <div className="pt-4 border-t border-border space-y-4">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Financial year
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              Document numbers are counted per financial year, so this decides when the counters
              start again from one.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field
              label="Current financial year"
              htmlFor="currentFY"
              error={errors.currentFY}
              help={describeFY(values.currentFY || null, startMonth)}
            >
              <input
                id="currentFY"
                className="form-input font-mono"
                placeholder="2425"
                maxLength={4}
                value={values.currentFY ?? ''}
                onChange={(e) => set('currentFY', e.target.value.replace(/\D/g, ''))}
              />
            </Field>

            <Field label="Year starts in" htmlFor="fyStartMonth" error={errors.fyStartMonth}>
              <select
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
              </select>
            </Field>

            <Field
              label="Books start from"
              htmlFor="booksStartDate"
              error={errors.booksStartDate}
              help="Nothing can be dated before this. Set it to the day you start using the ERP."
              span={2}
            >
              <input
                id="booksStartDate"
                type="date"
                className="form-input"
                value={(values.booksStartDate ?? '').slice(0, 10)}
                onChange={(e) => set('booksStartDate', e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="flex justify-end pt-2 border-t border-border">
          <SaveButton saving={saving} />
        </div>
      </form>
    </SettingsCard>
  )
}

// ── Document numbering ───────────────────────────────────────────────────────

function DocumentNumbering() {
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
      title="Document numbering"
      description="What a sales order, invoice or purchase order is called when it is created."
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
                <th>Next number</th>
                <th style={{ textAlign: "right" }}>Used so far</th>
                <th style={{ textAlign: "center" }}>In use</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {series.map((s) => {
                const isEditing = editingId === s.id
                const preview = isEditing
                  ? [
                      draft.prefix || s.prefix,
                      s.financialYear,
                      String(s.lastNumber + 1).padStart(Number(draft.padding) || s.padding, '0'),
                    ].join(draft.separator)
                  : s.nextNumber

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
                        <span className="font-mono text-teal-400">{s.prefix}</span>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <select
                          className="form-input h-8 w-20"
                          value={draft.separator}
                          onChange={(e) => setDraft((d) => ({ ...d, separator: e.target.value }))}
                          aria-label={`${s.label} separator`}
                        >
                          <option value="-">dash</option>
                          <option value="/">slash</option>
                          <option value="">nothing</option>
                        </select>
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
                    <td className="font-mono text-xs">{preview}</td>
                    <td className="text-right text-muted-foreground">{s.lastNumber}</td>
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
        The counter itself is moved by the ERP and cannot be edited here — documents already issued
        keep the numbers they were given.
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
                  className="text-xs text-muted-foreground hover:text-teal-400 transition-colors"
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
