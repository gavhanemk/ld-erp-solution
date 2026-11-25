'use client'

import type { ReactNode } from 'react'
import type { GstSplit, PriceResult } from '@ld-erp/shared'
import { TaxBreakdown } from './TaxBreakdown'

const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={strong ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
      <span className={`text-foreground whitespace-nowrap tabular-nums ${strong ? 'font-medium' : ''}`}>
        {inr(value)}
      </span>
    </div>
  )
}

/**
 * The figures of a purchase order or bill, read-only, every one from the one
 * calculation (priceDocument) — the same sum the server saves and the print
 * shows, so the rows always add up to the total under them.
 */
export function PurchaseSummary({
  result,
  split,
  totalLabel = 'Grand total',
  discountLabel = 'Discount',
  extra,
}: {
  result: PriceResult
  /** null while no supplier is chosen. */
  split: GstSplit | null
  totalLabel?: string
  discountLabel?: string
  /** Rows after the total, e.g. TDS and net payable on a bill. */
  extra?: ReactNode
}) {
  return (
    <div className="space-y-1.5 text-sm">
      <Row label="Items" value={result.gross} />
      {result.totalDiscount > 0 && <Row label={discountLabel} value={-result.totalDiscount} />}
      <Row label="Net items" value={result.goodsTaxable} strong />
      {result.chargeTotal > 0 && <Row label="Charges before GST" value={result.chargeTotal} />}

      <div className="border-border/60 space-y-1.5 border-t pt-1.5">
        {split === 'CGST_SGST' && (
          <>
            <Row label="CGST" value={result.cgst} />
            <Row label="SGST" value={result.sgst} />
          </>
        )}
        {split === 'IGST' && <Row label="IGST" value={result.igst} />}
        {split === null && <Row label="GST" value={result.tax} />}
        {split === 'NONE' ? (
          <p className="text-muted-foreground text-xs">No GST — this supplier is not registered.</p>
        ) : (
          <Row label="Total tax" value={result.tax} strong />
        )}
        {split !== 'NONE' && <TaxBreakdown result={result} split={split} />}
        {split === null && (
          <p className="text-muted-foreground text-xs">
            Pick the supplier to see whether this is CGST + SGST or IGST.
          </p>
        )}
      </div>

      {result.untaxedExtra > 0 && <Row label="Other charges" value={result.untaxedExtra} />}
      {Math.abs(result.roundOff) >= 0.005 && <Row label="Rounding" value={result.roundOff} />}

      <div className="border-primary/20 bg-primary/5 mt-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
        <span className="text-foreground font-semibold">{totalLabel}</span>
        <span className="text-foreground whitespace-nowrap text-lg font-semibold tabular-nums">
          ₹{inr(result.total)}
        </span>
      </div>
      {extra}
    </div>
  )
}
