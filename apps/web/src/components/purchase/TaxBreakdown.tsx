'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CHARGE_GST_MODE_LABEL, type ChargeGstMode, type GstSplit, type PriceResult } from '@ld-erp/shared'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

/**
 * Where the GST on a purchase order or bill comes from.
 *
 * One row per GST rate, goods and charges together: what is taxed at that
 * rate and the tax on it, split into CGST + SGST or IGST — "GST @5% on
 * ₹12,000 = ₹600", with "goods ₹X · charges ₹Y" underneath when both are at
 * that rate. A charge may carry no GST of its own (`NONE`), in which case it
 * never appears here — see `ChargeGstControl` for choosing a charge's GST.
 *
 * Every figure is read from the one calculation (priceDocument), so the rows
 * always add up to the totals beside them.
 */

const inr = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function TaxBreakdown({
  result,
  split,
}: {
  result: PriceResult
  /** null while no supplier is chosen: the tax is shown as one GST figure. */
  split: GstSplit | null
}) {
  const [open, setOpen] = useState(true)
  const taxed = result.byRate.filter((b) => b.tax > 0 || b.gstRate > 0)

  if (split === 'NONE') {
    return (
      <p className="text-muted-foreground text-xs">
        No GST — this supplier is not registered.
      </p>
    )
  }
  if (taxed.length === 0) return null

  return (
    <div className="border-border bg-secondary/40 rounded-lg border px-2.5 py-2">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-xs font-medium"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        How the GST is worked out
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {taxed.map((b) => (
            <div key={b.gstRate} className="text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-foreground">
                  GST @{b.gstRate}% on ₹{inr(b.taxable)}
                </span>
                <span className="text-foreground font-medium tabular-nums">₹{inr(b.tax)}</span>
              </div>
              <div className="text-muted-foreground flex items-baseline justify-between gap-3 text-[11px]">
                <span>
                  {b.goodsTaxable > 0 && `goods ₹${inr(b.goodsTaxable)}`}
                  {b.goodsTaxable > 0 && b.chargeTaxable > 0 && ' · '}
                  {b.chargeTaxable > 0 && `charges ₹${inr(b.chargeTaxable)}`}
                </span>
                <span className="tabular-nums">
                  {split === 'IGST'
                    ? `IGST ${inr(b.igst)}`
                    : split === 'CGST_SGST'
                      ? `CGST ${inr(b.cgst)} + SGST ${inr(b.sgst)}`
                      : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** One HSN / SAC code, as offered to a charge taken by HSN. */
export interface HsnOption {
  id: string
  code: string
  description: string
  gstRate: string | number
}

const GST_MODE_SHORT: Record<ChargeGstMode, string> = { INHERIT: 'Goods', HSN: 'HSN', MANUAL: '%', NONE: 'None' }

/**
 * Where one charge's GST comes from, beside its amount box: an HSN / SAC code
 * picked for it, a rate typed by hand, or none at all — a charge is always
 * typed as the figure before GST, and its GST is always added on top, so
 * there is nothing here to say whether it sits inside the figure or outside
 * it (contrast a sales charge's `ChargeTaxTreatment`, which there is).
 *
 * The three choices sit together as a segmented control, like the ₹ / %
 * buttons beside a charge's amount, so the one in use is always in sight
 * rather than hidden inside a dropdown.
 */
export function ChargeGstControl({
  mode,
  onMode,
  hsnId,
  onHsnId,
  manualRate,
  onManualRate,
  hsnOptions,
  label,
  disabled,
  resolvedRate,
  tax,
}: {
  mode: ChargeGstMode
  onMode: (m: ChargeGstMode) => void
  hsnId: string
  onHsnId: (id: string) => void
  manualRate: string
  onManualRate: (v: string) => void
  hsnOptions: HsnOption[]
  /** The charge's name, for screen readers. */
  label: string
  /** The supplier is not registered: no GST on anything, so there is nothing to choose. */
  disabled?: boolean
  /** The rate actually applied — the HSN code's, or the one typed. 0 when NONE or not yet chosen. */
  resolvedRate: number
  /** The GST this charge comes to at that rate, for the "+ ₹X GST" caption. */
  tax: number
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground text-[10px] uppercase tracking-wide">GST</span>
      <div
        role="group"
        aria-label={`GST on ${label}`}
        className="border-border flex h-7 shrink-0 overflow-hidden rounded-lg border"
      >
        {(['HSN', 'MANUAL', 'NONE'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            disabled={disabled}
            title={CHARGE_GST_MODE_LABEL[m]}
            onClick={() => onMode(m)}
            className={`px-2 text-[11px] font-semibold transition-colors ${
              mode === m
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            }`}
          >
            {GST_MODE_SHORT[m]}
          </button>
        ))}
      </div>
      {mode === 'HSN' && (
        <SmartSelect
          className="form-input h-7 w-56 text-xs"
          value={hsnId}
          disabled={disabled}
          onChange={(e) => onHsnId(e.target.value)}
          aria-label={`HSN / SAC code for ${label}`}
        >
          <option value="">Pick an HSN / SAC code…</option>
          {hsnOptions.map((h) => (
            <option key={h.id} value={h.id}>
              {h.code} — {h.description} ({Number(h.gstRate)}%)
            </option>
          ))}
        </SmartSelect>
      )}
      {mode === 'MANUAL' && (
        <StepInput
          decimals
          max={100}
          className="form-input h-7 w-16 text-right text-xs"
          placeholder="0"
          value={manualRate}
          disabled={disabled}
          onValueChange={onManualRate}
          aria-label={`GST % on ${label}`}
        />
      )}
      {mode === 'HSN' && !hsnId && !disabled && <span className="warn-text text-[11px]">Pick a code</span>}
      {!disabled && resolvedRate > 0 && tax > 0 && (
        <span className="text-muted-foreground text-[11px] tabular-nums">
          + ₹{inr(tax)} GST @{resolvedRate}%
        </span>
      )}
    </div>
  )
}
