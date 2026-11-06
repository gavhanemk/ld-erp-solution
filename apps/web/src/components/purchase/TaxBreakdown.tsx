'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { GstSplit, PriceResult } from '@ld-erp/shared'

/**
 * Where the GST on a purchase order or bill comes from.
 *
 * One row per GST rate on the goods: what is taxed at that rate and the tax on
 * it, split into CGST + SGST or IGST — "GST @5% on ₹12,000 = ₹600". Charges
 * carry no GST of their own (they are the supplier's figure with any GST
 * already in it), so they do not appear here.
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

