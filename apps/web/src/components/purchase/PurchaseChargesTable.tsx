'use client'

import { useState, type ReactNode } from 'react'
import { Pencil, X } from 'lucide-react'
import type { ChargeTaxSnapshot, GstSplit, PricedCharge } from '@ld-erp/shared'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { ChargeTaxDialog } from './ChargeTaxDialog'
import { chargeGstLabel } from './chargeRules'
import type { HsnOption } from './TaxBreakdown'

export interface ChargeTableRow {
  key: string
  name: string
  unit: 'INR' | '%'
  /** What is in the amount box. */
  typed: string
  /** What the typed figure comes to in rupees (a % worked out on the goods). */
  enteredAmount: number
  config: ChargeTaxSnapshot
  priced?: PricedCharge
  /** Changed in this form and not yet saved — "Undo this change" is offered. */
  unsavedChange: boolean
  /** Priced from a saved document rather than today's master: what to call that. */
  savedAs?: string
}

const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num = (s: string) => Number(s) || 0

/**
 * The extra charges on a purchase order or bill, one row each.
 *
 * The operator picks the charge and types its amount; the GST comes from
 * Masters → Charges and each row says plainly where its rate comes from.
 * Changing the tax is a separate, deliberate step behind the pencil, offered
 * only to users allowed to make it.
 */
export function PurchaseChargesTable({
  rows,
  split,
  goodsValue,
  canChangeTax,
  hsnOptions,
  addOptions,
  onAmount,
  onUnit,
  onRemove,
  onAdd,
  onTaxChange,
  preview,
  emptyHint,
  footer,
}: {
  rows: ChargeTableRow[]
  split: GstSplit | null
  /** The goods after discounts, before GST: what a % charge is a % of. */
  goodsValue: number
  canChangeTax: boolean
  hsnOptions: HsnOption[]
  addOptions: { id: string; name: string }[]
  onAmount: (key: string, value: string) => void
  /** `typed` is what the amount box should hold in the new unit. */
  onUnit: (key: string, unit: 'INR' | '%', typed: string) => void
  onRemove: (key: string) => void
  onAdd: (typeId: string) => void
  /** null: back to the setting the charge had before this form changed it. */
  onTaxChange: (key: string, config: ChargeTaxSnapshot | null) => void
  preview: (key: string, config: ChargeTaxSnapshot) => { rate: string; tax: number }
  emptyHint?: ReactNode
  footer?: ReactNode
}) {
  const [taxFor, setTaxFor] = useState<string | null>(null)
  const editing = rows.find((r) => r.key === taxFor)

  return (
    <div className="space-y-2">
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[35rem] text-sm">
            <thead>
              <tr className="text-muted-foreground border-border border-b text-left text-[11px] font-semibold uppercase tracking-wider">
                <th className="py-1.5 pr-2 font-semibold">Charge</th>
                <th className="w-[9.5rem] px-2 py-1.5 text-right font-semibold">Amount</th>
                <th className="w-[8.5rem] px-2 py-1.5 font-semibold">GST</th>
                <th className="w-[5.5rem] px-2 py-1.5 text-right font-semibold">Tax</th>
                <th className="w-[6.5rem] px-2 py-1.5 text-right font-semibold">Total</th>
                <th className="w-[4rem] py-1.5 pl-1" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const gst = chargeGstLabel(r.config, r.priced, split, { savedAs: r.savedAs })
                return (
                  <tr key={r.key} className="border-border/60 border-b align-top last:border-0">
                    <td className="text-foreground py-2 pr-2 pt-3.5">{r.name}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <StepInput
                          decimals
                          max={r.unit === '%' ? 100 : undefined}
                          className="form-input h-9 w-[5.5rem] text-right"
                          placeholder="0.00"
                          value={r.typed}
                          onValueChange={(v) => onAmount(r.key, v)}
                          aria-label={`${r.name} ${r.unit === '%' ? 'percent' : 'amount'}`}
                        />
                        {/* Rupees or percent as two buttons, both always in sight:
                          a dropdown showing "₹" was read as a label. Pressing %
                          keeps a figure that can be a percentage (10 → 10%);
                          pressing ₹ keeps what the % came to. */}
                        <div
                          role="group"
                          aria-label={`${r.name} in rupees or percent`}
                          className="border-border flex h-9 shrink-0 overflow-hidden rounded-lg border"
                        >
                          {(['INR', '%'] as const).map((unit) => (
                            <button
                              key={unit}
                              type="button"
                              aria-pressed={r.unit === unit}
                              title={unit === '%' ? `Type ${r.name} as a % of the goods value` : `Type ${r.name} as an amount in ₹`}
                              onClick={() => {
                                if (unit === r.unit) return
                                const typed =
                                  unit === '%'
                                    ? num(r.typed) > 0 && num(r.typed) <= 100
                                      ? r.typed
                                      : ''
                                    : r.enteredAmount
                                      ? String(r.enteredAmount)
                                      : ''
                                onUnit(r.key, unit, typed)
                              }}
                              className={`w-7 text-sm font-semibold transition-colors ${
                                r.unit === unit
                                  ? 'bg-primary/15 text-primary'
                                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                              }`}
                            >
                              {unit === '%' ? '%' : '₹'}
                            </button>
                          ))}
                        </div>
                      </div>
                      {r.unit === '%' && (
                        <p className="text-muted-foreground mt-1 text-right text-[11px] tabular-nums">
                          {goodsValue > 0
                            ? `${num(r.typed)}% of goods ₹${inr(goodsValue)} = ₹${inr(r.enteredAmount)}`
                            : 'Add the goods first — the % is worked out on their value.'}
                        </p>
                      )}
                    </td>
                    <td className="px-2 py-2 pt-2.5">
                      <span className="text-foreground block tabular-nums">{gst.rate}</span>
                      {gst.source && (
                        <span
                          className={`block text-[11px] leading-snug ${gst.changed ? 'warn-text' : 'text-muted-foreground'}`}
                          title={gst.source}
                        >
                          {gst.source}
                        </span>
                      )}
                    </td>
                    <td className="text-foreground px-2 py-2 pt-3.5 text-right tabular-nums">
                      {inr(r.priced?.tax ?? 0)}
                    </td>
                    <td className="text-foreground px-2 py-2 pt-3.5 text-right font-medium tabular-nums">
                      {inr(r.priced?.payable ?? r.enteredAmount)}
                    </td>
                    <td className="py-2 pl-2 pt-2.5">
                      <div className="flex justify-end gap-0.5">
                        {canChangeTax && (
                          <button
                            type="button"
                            onClick={() => setTaxFor(r.key)}
                            className="btn-ghost text-muted-foreground hover:text-foreground p-1.5"
                            title={`Change the tax on ${r.name} for this document`}
                            aria-label={`Change tax on ${r.name}`}
                          >
                            <Pencil size={14} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onRemove(r.key)}
                          className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400"
                          title={`Take ${r.name} off`}
                          aria-label={`Remove ${r.name}`}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {addOptions.length > 0 && (
        <SmartSelect
          className="form-input h-9 w-full max-w-xs text-sm"
          value=""
          onChange={(e) => {
            if (e.target.value) onAdd(e.target.value)
          }}
          aria-label="Add a charge"
        >
          <option value="">+ Add charge</option>
          {addOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </SmartSelect>
      )}
      {emptyHint}
      {footer}

      {editing && (
        <ChargeTaxDialog
          open
          name={editing.name}
          config={editing.config}
          hsnOptions={hsnOptions}
          canReset={editing.unsavedChange}
          preview={(c) => preview(editing.key, c)}
          onApply={(c) => {
            onTaxChange(editing.key, c)
            setTaxFor(null)
          }}
          onReset={() => {
            onTaxChange(editing.key, null)
            setTaxFor(null)
          }}
          onClose={() => setTaxFor(null)}
        />
      )}
    </div>
  )
}
