'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Loader2, Percent, Plus, X } from 'lucide-react'
import { apiErrorMessage, can } from '@/lib/api'
import { settingsApi } from '@/lib/settingsApi'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

/**
 * The TDS box at the foot of an expense bill — the old ERP's "TDS Section",
 * "Auto cal" and "TDS Amount", with the year-so-far check beside them.
 *
 * Pure display and input: the bill form holds the values and works out the
 * figures, so the screen and the saved bill agree.
 */

/** A section with the rate and limits in force on the bill's date. */
export interface TdsChoice {
  id: string
  section: string
  label: string
  rate: number
  noPanRate: number | null
  singleLimit: number | null
  yearlyLimit: number | null
  /** "194C — Contractor (1%)" */
  name: string
}

const inr = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const inr0 = (v: number) => `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

export function ExpenseTdsPanel({
  sections,
  sectionId,
  onSection,
  auto,
  onAuto,
  typed,
  onTyped,
  computed,
  rate,
  panMissing,
  taxable,
  yearSoFar,
  onSectionAdded,
}: {
  sections: TdsChoice[]
  sectionId: string
  onSection: (id: string) => void
  auto: boolean
  onAuto: (auto: boolean) => void
  typed: string
  onTyped: (v: string) => void
  /** TDS worked out from the rate, to the rupee. */
  computed: number
  /** The rate in use, after the no-PAN rule. */
  rate: number | null
  panMissing: boolean
  /** This bill's value before GST — what TDS and its limits are measured on. */
  taxable: number
  /** This supplier's bills so far this financial year, not counting this one. */
  yearSoFar: { taxable: number; bills: number; year: string } | null
  /** A section was just added from the list: reload and pick it. */
  onSectionAdded: (id: string) => void
}) {
  const [adding, setAdding] = useState<string | null>(null)
  const chosen = sections.find((s) => s.id === sectionId) ?? null

  /*
   * Whether the limits say TDS is due. Only spoken when Settings holds the
   * limits — without them the form would be guessing at the law.
   */
  const yearTotal = (yearSoFar?.taxable ?? 0) + taxable
  const overSingle = chosen?.singleLimit != null && taxable > chosen.singleLimit
  const overYear = chosen?.yearlyLimit != null && yearTotal > chosen.yearlyLimit
  const hasLimits = chosen != null && (chosen.singleLimit != null || chosen.yearlyLimit != null)

  return (
    <div className="space-y-2.5 text-sm">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
        <div className="min-w-0">
          <label className="text-muted-foreground mb-1 block text-xs" htmlFor="bill-tds-section">
            TDS section
          </label>
          <SmartSelect
            id="bill-tds-section"
            className="form-input h-8 text-xs"
            value={sectionId}
            onChange={(e) => onSection(e.target.value)}
            onCreate={can('settings', 'create') ? (t) => setAdding(t) : undefined}
            createNoun="TDS section"
          >
            <option value="">No TDS on this bill</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SmartSelect>
        </div>
        <label className="text-muted-foreground flex h-8 cursor-pointer items-center gap-1.5 text-xs whitespace-nowrap">
          <input
            type="checkbox"
            checked={auto}
            disabled={!chosen}
            onChange={(e) => onAuto(e.target.checked)}
          />
          Auto calculate
        </label>
      </div>

      {chosen && (
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="bill-tds-amount" className="text-muted-foreground">
            TDS{rate != null ? ` @ ${rate}%` : ''} on ₹{inr(taxable)}
          </label>
          {auto ? (
            <span className="text-foreground tabular-nums">−{inr(computed)}</span>
          ) : (
            <StepInput
              id="bill-tds-amount"
              className="form-input h-8 w-32 text-right"
              decimals
              value={typed}
              onValueChange={onTyped}
              placeholder={String(computed)}
              aria-label="TDS amount"
            />
          )}
        </div>
      )}

      {chosen && panMissing && (
        <p className="warn-text flex items-start gap-1.5 text-xs">
          <AlertCircle size={13} className="mt-px shrink-0" />
          {chosen.noPanRate != null
            ? `No PAN on this supplier — the no-PAN rate of ${chosen.noPanRate}% applies. Add their PAN in Masters → Suppliers.`
            : 'No PAN on this supplier — a higher rate usually applies. Add their PAN, or set the no-PAN rate in Settings → TDS sections.'}
        </p>
      )}

      {yearSoFar && (chosen || yearSoFar.taxable > 0) && (
        <p className="text-muted-foreground text-xs">
          This year ({yearSoFar.year}) so far: {inr0(yearSoFar.taxable)} over {yearSoFar.bills}{' '}
          {yearSoFar.bills === 1 ? 'bill' : 'bills'}, {inr0(yearTotal)} with this one.
          {hasLimits && (
            <>
              {' '}
              {overSingle || overYear ? (
                <span className="warn-text">
                  Over the limit
                  {overSingle && chosen?.singleLimit != null ? ` of ${inr0(chosen.singleLimit)} a bill` : ''}
                  {overSingle && overYear ? ' and' : ''}
                  {overYear && chosen?.yearlyLimit != null ? ` of ${inr0(chosen.yearlyLimit)} a year` : ''} — TDS applies.
                </span>
              ) : (
                <span>
                  Under the limits ({chosen?.singleLimit != null ? `${inr0(chosen.singleLimit)} a bill` : ''}
                  {chosen?.singleLimit != null && chosen?.yearlyLimit != null ? ', ' : ''}
                  {chosen?.yearlyLimit != null ? `${inr0(chosen.yearlyLimit)} a year` : ''}) — TDS may not be due yet.
                </span>
              )}
            </>
          )}
        </p>
      )}

      {adding !== null && (
        <NewTdsSectionDialog
          typed={adding}
          onClose={() => setAdding(null)}
          onCreated={(id) => {
            setAdding(null)
            onSectionAdded(id)
          }}
        />
      )}
    </div>
  )
}

const todayValue = () => {
  const d = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/**
 * "+ Add new" in the TDS list: a section the mill has not needed before,
 * added to Settings and picked on the bill. Limits and the no-PAN rate are
 * filled in later from Settings → TDS sections.
 */
function NewTdsSectionDialog({
  typed,
  onClose,
  onCreated,
}: {
  typed: string
  onClose: () => void
  onCreated: (id: string) => void
}) {
  // What was typed in the search is usually the section code, e.g. "194I".
  const [section, setSection] = useState(/^\d/.test(typed.trim()) ? typed.trim() : '')
  const [label, setLabel] = useState(/^\d/.test(typed.trim()) ? '' : typed.trim())
  const [rate, setRate] = useState('')
  const [from, setFrom] = useState(todayValue())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ready = section.trim() && label.trim() && rate !== '' && from

  const save = async () => {
    if (!ready) return
    setSaving(true)
    setError(null)
    try {
      const res = await settingsApi.tdsSections.create({
        section: section.trim(),
        label: label.trim(),
        rate: Number(rate),
        effectiveFrom: from,
      })
      onCreated(res.data.id)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not add that section.'))
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        className="glass-card po-form w-full max-w-lg overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-tds-title"
      >
        <div className="border-border flex items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-9 w-9 items-center justify-center rounded-xl border">
              <Percent size={17} className="text-primary" />
            </div>
            <div>
              <h2 id="new-tds-title" className="text-foreground text-lg font-semibold">
                New TDS Section
              </h2>
              <p className="text-muted-foreground text-xs">
                Limits and the no-PAN rate can be added later in Settings.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          {error && (
            <p className="flex items-start gap-2 text-sm text-red-400">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              {error}
            </p>
          )}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="form-label" htmlFor="nt-section">
                Section<span className="ml-0.5 text-red-400">*</span>
              </label>
              <input
                id="nt-section"
                className="form-input"
                placeholder="194I"
                value={section}
                onChange={(e) => setSection(e.target.value)}
                autoFocus
              />
            </div>
            <div className="col-span-2">
              <label className="form-label" htmlFor="nt-label">
                What it is for<span className="ml-0.5 text-red-400">*</span>
              </label>
              <input
                id="nt-label"
                className="form-input"
                placeholder="Rent — plant and machinery"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div>
              <label className="form-label" htmlFor="nt-rate">
                Rate (%)<span className="ml-0.5 text-red-400">*</span>
              </label>
              <StepInput
                id="nt-rate"
                className="form-input"
                decimals
                max={100}
                step={0.5}
                value={rate}
                onValueChange={setRate}
              />
            </div>
            <div className="col-span-2">
              <label className="form-label" htmlFor="nt-from">
                Starts from<span className="ml-0.5 text-red-400">*</span>
              </label>
              <input
                id="nt-from"
                type="date"
                className="form-input"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="border-border flex justify-end gap-3 border-t px-5 py-3">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !ready}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            Add section
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
