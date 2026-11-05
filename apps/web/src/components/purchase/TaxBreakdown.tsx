'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { GST_RATE_CHOICES, type GstSplit, type PriceResult } from '@ld-erp/shared'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Where the GST on a purchase order or bill comes from.
 *
 * One row per GST rate on the document: what is taxed at that rate (goods and
 * charges, shown apart) and the tax on it, split into CGST + SGST or IGST.
 * Adding ₹1,200 of freight at 5% then reads as "GST @5% on ₹13,200 — goods
 * ₹12,000, charges ₹1,200", not as SGST quietly moving from 300 to 330.
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

/**
 * The GST % on one charge, chosen on the document.
 *
 * Offers the standard GST rates, and always keeps the rate already on the
 * charge — an order saved at a rate no longer on the list still shows it.
 */
export function ChargeGstSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: string
  onChange: (rate: string) => void
  /** The charge's name, for screen readers. */
  label: string
  disabled?: boolean
}) {
  const current = Number(value)
  const choices: number[] = [...GST_RATE_CHOICES]
  if (value !== '' && Number.isFinite(current) && !choices.includes(current)) choices.push(current)
  choices.sort((a, b) => a - b)

  return (
    <SmartSelect
      className="form-input h-8 w-[7rem] shrink-0 text-right text-xs"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={`GST on ${label}`}
      title={`GST on ${label}`}
    >
      {choices.map((r) => (
        <option key={r} value={String(r)}>
          {`${r}% GST`}
        </option>
      ))}
    </SmartSelect>
  )
}
