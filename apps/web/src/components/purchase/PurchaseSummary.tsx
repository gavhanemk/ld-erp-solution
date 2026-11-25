'use client'

import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { GstSplit, PriceResult } from '@ld-erp/shared'
import { summaryModel } from './purchaseSummaryModel'

const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function Row({ label, value, strong, muted }: { label: ReactNode; value: number; strong?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={strong ? 'text-foreground font-medium' : muted ? 'text-muted-foreground text-xs' : 'text-muted-foreground'}>
        {label}
      </span>
      <span
        className={`whitespace-nowrap tabular-nums ${strong ? 'text-foreground font-semibold' : muted ? 'text-muted-foreground text-xs' : 'text-foreground'}`}
      >
        {inr(value)}
      </span>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wider">{title}</p>
      {children}
    </div>
  )
}

/**
 * What a purchase order or bill comes to, laid out so it can be followed line
 * by line (25 Nov 2026): the items and their GST, each additional charge and
 * its GST, the tax, then the final amount — read-only, every figure from the
 * one calculation (priceDocument) that the server saves and the print shows.
 * "How this is worked out" opens the same figures item by item and charge by
 * charge.
 */
export function PurchaseSummary({
  result,
  split,
  totalLabel = 'Grand total',
  itemNames = [],
  chargeNames = [],
  extra,
}: {
  result: PriceResult
  /** null while no supplier is chosen. */
  split: GstSplit | null
  totalLabel?: string
  /** Names for the breakdown, in the order the lines were priced. */
  itemNames?: string[]
  chargeNames?: string[]
  /** Rows after the total, e.g. TDS and net payable on a bill. */
  extra?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const m = summaryModel(result, split, { itemNames, chargeNames })
  const none = split === 'NONE'
  const many = m.charges.length > 1

  return (
    <div className="space-y-4 text-sm">
      <Group title="Items">
        <Row label="Item value" value={m.items.value} />
        {m.items.discount > 0 && (
          <>
            <Row label="Less discount" value={-m.items.discount} />
            <Row label="Item taxable amount" value={m.items.taxable} strong />
          </>
        )}
        {!none && <Row label={`Item GST (${m.items.rateText})`} value={m.items.gst} />}
      </Group>

      {m.charges.length > 0 && (
        <Group title="Additional charges">
          {m.charges.map((c, i) => (
            <div key={i} className="space-y-1">
              <Row label={c.name} value={c.amount} />
              {!none && <Row label={`${c.name} GST (${c.rateText})`} value={c.gst} muted />}
            </div>
          ))}
          {many && (
            <div className="border-border/60 space-y-1 border-t pt-1.5">
              <Row label="Total additional charges" value={m.chargeTotal} strong />
              {!none && <Row label="Tax on additional charges" value={m.chargeGst} />}
            </div>
          )}
        </Group>
      )}

      <Group title="Tax">
        {none ? (
          <p className="text-muted-foreground text-xs">No GST — this supplier is not registered.</p>
        ) : (
          <>
            <Row label="Total GST" value={m.totalGst} strong />
            {split === 'CGST_SGST' && (
              <p className="text-muted-foreground flex justify-between text-xs tabular-nums">
                <span>CGST {inr(m.cgst)} + SGST {inr(m.sgst)}</span>
                <span>within the state</span>
              </p>
            )}
            {split === 'IGST' && (
              <p className="text-muted-foreground flex justify-between text-xs tabular-nums">
                <span>IGST {inr(m.igst)}</span>
                <span>other state</span>
              </p>
            )}
            {split === null && (
              <p className="text-muted-foreground text-xs">
                Pick the supplier to see whether this is CGST + SGST or IGST.
              </p>
            )}
          </>
        )}
        {m.untaxedExtra > 0 && <Row label="Other charges (no GST)" value={m.untaxedExtra} />}
        {Math.abs(m.roundOff) >= 0.005 && <Row label="Rounding" value={m.roundOff} />}
      </Group>

      <div className="border-primary/25 bg-primary/5 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
        <span>
          <span className="text-foreground block font-semibold">{totalLabel}</span>
          <span className="text-muted-foreground block text-[11px]">
            Items {none ? '' : '+ item GST '}+ charges{none ? '' : ' + charge GST'}
          </span>
        </span>
        <span className="text-foreground whitespace-nowrap text-lg font-semibold tabular-nums">₹{inr(m.grandTotal)}</span>
      </div>

      {(m.itemRows.length > 0 || m.charges.length > 0) && (
        <div className="bg-secondary/40 rounded-lg px-2.5 py-2">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-xs font-medium"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            How this is worked out
          </button>
          {open && (
            <div className="mt-2 space-y-3 text-xs">
              <table className="w-full tabular-nums">
                <thead>
                  <tr className="text-muted-foreground text-left text-[10px] uppercase tracking-wider">
                    <th className="py-1 font-semibold">Item</th>
                    <th className="py-1 text-right font-semibold">Taxable</th>
                    <th className="py-1 text-right font-semibold">GST</th>
                  </tr>
                </thead>
                <tbody>
                  {m.itemRows.map((l, i) => (
                    <tr key={i} className="border-border/50 border-t align-top">
                      <td className="text-foreground py-1 pr-2">{l.name}</td>
                      <td className="text-foreground py-1 text-right">{inr(l.taxable)}</td>
                      <td className="text-foreground py-1 text-right">
                        {inr(l.gst)}
                        <span className="text-muted-foreground block text-[10px]">{l.rateText}</span>
                      </td>
                    </tr>
                  ))}
                  {m.charges.map((c, i) => (
                    <tr key={`c${i}`} className="border-border/50 border-t align-top">
                      <td className="text-foreground py-1 pr-2">{c.name}</td>
                      <td className="text-foreground py-1 text-right">{inr(c.amount)}</td>
                      <td className="text-foreground py-1 text-right">
                        {inr(c.gst)}
                        <span className="text-muted-foreground block text-[10px]">{c.rateText}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!none && result.byRate.some((b) => b.tax > 0) && (
                <div className="space-y-1">
                  <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">GST by rate</p>
                  {result.byRate
                    .filter((b) => b.tax > 0)
                    .map((b) => (
                      <p key={b.gstRate} className="text-foreground flex justify-between gap-3 tabular-nums">
                        <span>
                          {b.gstRate}% on ₹{inr(b.taxable)}
                        </span>
                        <span className="text-muted-foreground">
                          {split === 'IGST' ? `IGST ${inr(b.igst)}` : `CGST ${inr(b.cgst)} + SGST ${inr(b.sgst)}`}
                        </span>
                      </p>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {extra}
    </div>
  )
}
