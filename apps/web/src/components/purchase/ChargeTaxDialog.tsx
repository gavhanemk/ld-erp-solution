'use client'

import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, X } from 'lucide-react'
import type { ChargeTaxCategory, ChargeTaxSnapshot } from '@ld-erp/shared'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { useEscape } from '@/lib/useEscape'
import type { HsnOption } from './TaxBreakdown'
import { configFromDraft, draftFromConfig, taxDraftProblem, type ChargeTaxDraft } from './chargeRules'

const MODES: { value: ChargeTaxDraft['mode']; label: string; hint: string }[] = [
  { value: 'INHERIT', label: 'Follow the goods', hint: 'Taxed at the goods’ own rate — freight on the supplier’s own bill' },
  { value: 'HSN', label: 'HSN / SAC code', hint: 'The rate of a service code, e.g. a transporter’s SAC' },
  { value: 'MANUAL', label: 'A rate I set', hint: 'Type the GST %' },
  { value: 'NONE', label: 'No GST', hint: 'Exempt, nil-rated or outside GST' },
]
const CATEGORIES: { value: ChargeTaxCategory; label: string }[] = [
  { value: 'TAXABLE', label: 'Taxable' },
  { value: 'EXEMPT', label: 'Exempt' },
  { value: 'NIL_RATED', label: 'Nil-rated' },
  { value: 'NON_GST', label: 'Non-GST' },
]
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Changing one charge's tax on one document — a deliberate step, offered only
 * to users allowed to make it (the server refuses anyone else).
 *
 * Nothing on the charge changes until Apply. The draft is made afresh from
 * the charge each time the window opens, so a half-made choice is never left
 * lying in view while the charge is priced at something else.
 */
export function ChargeTaxDialog({
  open,
  name,
  config,
  hsnOptions,
  canReset,
  preview,
  onApply,
  onReset,
  onClose,
}: {
  open: boolean
  name: string
  config: ChargeTaxSnapshot
  hsnOptions: HsnOption[]
  /** A change made in this form and not yet saved can be undone. */
  canReset: boolean
  preview: (c: ChargeTaxSnapshot) => { rate: string; tax: number }
  onApply: (c: ChargeTaxSnapshot) => void
  onReset: () => void
  onClose: () => void
}) {
  const titleId = useId()
  const [draft, setDraft] = useState<ChargeTaxDraft>(() => draftFromConfig(config))
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (!open) return
    setDraft(draftFromConfig(config))
    setTried(false)
    // Only on opening: the draft must not follow the charge while it is being edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEscape(onClose, open)
  if (!open) return null

  const set = (patch: Partial<ChargeTaxDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const problem = taxDraftProblem(draft)
  const next = configFromDraft(config, draft, hsnOptions)
  const shown = draft.mode === 'HSN' && !draft.hsnCodeId ? null : preview(next)

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="glass-card flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-border flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h3 id={titleId} className="text-foreground text-sm font-semibold">
              Change tax on {name}
            </h3>
            <p className="text-muted-foreground mt-0.5 text-xs">
              This document only. Masters → Charges is not changed.
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost shrink-0 p-1.5" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
          <fieldset>
            <legend className="form-label">GST from</legend>
            <div className="grid gap-1.5">
              {MODES.map((m) => (
                <label
                  key={m.value}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 ${
                    draft.mode === m.value ? 'border-primary/50 bg-primary/5' : 'border-border'
                  }`}
                >
                  <input
                    type="radio"
                    name={`${titleId}-mode`}
                    className="mt-0.5"
                    checked={draft.mode === m.value}
                    onChange={() =>
                      set({
                        mode: m.value,
                        hsnCodeId: m.value === 'HSN' ? (draft.hsnCodeId ?? hsnOptions[0]?.id ?? null) : null,
                        taxCategory:
                          m.value === 'NONE'
                            ? draft.taxCategory === 'TAXABLE'
                              ? 'EXEMPT'
                              : draft.taxCategory
                            : draft.taxCategory === 'UNSPECIFIED' || draft.mode === 'NONE'
                              ? 'TAXABLE'
                              : draft.taxCategory,
                      })
                    }
                  />
                  <span>
                    <span className="text-foreground block text-sm">{m.label}</span>
                    <span className="text-muted-foreground block text-xs">{m.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {draft.mode === 'HSN' && (
            <div>
              <label className="form-label" htmlFor={`${titleId}-hsn`}>
                HSN / SAC code
              </label>
              <SmartSelect
                id={`${titleId}-hsn`}
                className="form-input h-9 w-full text-sm"
                value={draft.hsnCodeId ?? ''}
                onChange={(e) => set({ hsnCodeId: e.target.value || null })}
                aria-label="HSN / SAC code"
              >
                <option value="">Pick a code…</option>
                {hsnOptions.map((h) => (
                  <option key={h.id} value={h.id} data-sub={h.description}>
                    {h.code} · {Number(h.gstRate)}%
                  </option>
                ))}
              </SmartSelect>
            </div>
          )}

          {draft.mode === 'MANUAL' && (
            <div>
              <label className="form-label" htmlFor={`${titleId}-rate`}>
                GST %
              </label>
              <StepInput
                id={`${titleId}-rate`}
                decimals
                max={100}
                className="form-input h-9 w-28 text-right"
                value={String(draft.ownRate)}
                onValueChange={(v) => set({ ownRate: Number(v) || 0 })}
              />
            </div>
          )}

          {draft.mode !== 'NONE' && (
            <div>
              <span className="form-label">The amount typed is</span>
              <div className="border-border flex w-fit overflow-hidden rounded-lg border" role="group">
                {(['EXCLUSIVE', 'INCLUSIVE'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={draft.treatment === t}
                    onClick={() => set({ treatment: t })}
                    className={`px-3 py-1.5 text-xs font-medium ${
                      draft.treatment === t
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                    }`}
                  >
                    {t === 'EXCLUSIVE' ? 'Before GST' : 'GST included'}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="form-label" htmlFor={`${titleId}-cat`}>
                Classification
              </label>
              <select
                id={`${titleId}-cat`}
                className="form-input h-9"
                value={draft.taxCategory}
                onChange={(e) => set({ taxCategory: e.target.value as ChargeTaxCategory })}
              >
                {draft.taxCategory === 'UNSPECIFIED' && <option value="UNSPECIFIED">Choose…</option>}
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="form-label" htmlFor={`${titleId}-reason`}>
                Reason<span className="ml-0.5 text-red-500">*</span>
              </label>
              <input
                id={`${titleId}-reason`}
                className="form-input h-9"
                placeholder="e.g. freight on the supplier’s own bill"
                value={draft.reason}
                onChange={(e) => set({ reason: e.target.value })}
              />
            </div>
          </div>

          <p className="border-border/60 bg-secondary/40 rounded-lg border px-3 py-2 text-xs tabular-nums">
            {shown ? (
              <>
                New tax: <span className="text-foreground font-medium">{shown.rate}</span> ·{' '}
                <span className="text-foreground font-medium">₹{inr(shown.tax)}</span>
              </>
            ) : (
              'Pick a code to see the new tax.'
            )}
          </p>

          {tried && problem && (
            <p className="warn-text flex items-start gap-1.5 text-xs" role="alert">
              <AlertCircle size={13} className="mt-px shrink-0" />
              {problem}
            </p>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
          {canReset && (
            <button type="button" className="btn-ghost mr-auto text-xs" onClick={onReset}>
              Back to the master&apos;s setting
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setTried(true)
              if (!problem) onApply(next)
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
