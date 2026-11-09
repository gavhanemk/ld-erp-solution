'use client'

import { Plus, Trash2 } from 'lucide-react'
import { CHARGE_TAX_TREATMENT_LABEL, type ChargeTaxTreatment, type PricedSaleCharge } from '@ld-erp/shared'
import { formatRupees } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import type { TotalsCharge } from './orderTotals'

/**
 * The charges on a quotation or a sales order — transport, freight, packing —
 * picked from Masters → Charges: one row each, its figure, and how GST sits
 * on that figure. The same box on both forms, priced by the same engine, so a
 * quotation's charges read exactly as the order's will.
 *
 * Each row says in one line what happens to its figure:
 *   GST included   "GST 5% inside: ₹57.14 — nothing added on top"
 *   GST added      "+ GST 5%: ₹60.00"
 *   No GST         "No GST: added as it is, outside the taxable value"
 * A row starts with its charge type's own treatment (Masters → Charges) and
 * can be changed for this document.
 */

export interface SaleChargeType {
  id: string
  name: string
  defaultGstRate: string | number
  isActive: boolean
  applyOnSale: boolean
  taxTreatment?: ChargeTaxTreatment
  followsGoodsRate?: boolean
}

export interface SaleChargeDraft {
  key: string
  chargeTypeId: string
  amount: string
  /** '' until a charge type is picked; then its type's own, unless changed here. */
  treatment: ChargeTaxTreatment | ''
}

let chargeKey = 0
export const blankSaleCharge = (): SaleChargeDraft => ({ key: `ch${++chargeKey}`, chargeTypeId: '', amount: '', treatment: '' })

/** A saved document's charges, back into the box. */
export function chargeDraftsOf(saved: Array<{ chargeTypeId: string; amount: string | number; taxTreatment?: ChargeTaxTreatment | null }> | undefined): SaleChargeDraft[] {
  return (saved ?? []).map((c) => ({
    key: `ch${++chargeKey}`,
    chargeTypeId: c.chargeTypeId,
    amount: Number(c.amount) > 0 ? String(Number(c.amount)) : '',
    // A charge saved before charges said how GST sits on them had GST added on top.
    treatment: c.taxTreatment ?? 'EXCLUSIVE',
  }))
}

/** What the engine prices: the rows with a type and a figure, each with its treatment settled. */
export function chargesToPrice(rows: SaleChargeDraft[], typeById: Map<string, SaleChargeType>): TotalsCharge[] {
  return rows.flatMap((c) => {
    const type = typeById.get(c.chargeTypeId)
    const amount = Number(c.amount) || 0
    if (!type || !(amount > 0)) return []
    return [
      {
        key: c.key,
        amount,
        treatment: c.treatment || type.taxTreatment || 'INCLUSIVE',
        followsGoodsRate: type.followsGoodsRate ?? true,
        ownRate: Number(type.defaultGstRate) || 0,
      },
    ]
  })
}

/** What the server is sent. */
export function chargesToSave(rows: SaleChargeDraft[], typeById: Map<string, SaleChargeType>) {
  return chargesToPrice(rows, typeById).map((c) => ({ chargeTypeId: rows.find((r) => r.key === c.key)!.chargeTypeId, amount: c.amount, taxTreatment: c.treatment }))
}

const SHORT: Record<ChargeTaxTreatment, string> = { INCLUSIVE: 'GST incl.', EXCLUSIVE: '+ GST', NON_TAXABLE: 'No GST' }

/** The one line under a row: what its figure does to the bill. */
export function chargeNote(p: PricedSaleCharge) {
  const inr = (n: number) => formatRupees(n)
  if (p.treatment === 'NON_TAXABLE') return 'No GST: added as it is, outside the taxable value'
  if (p.treatment === 'INCLUSIVE') return p.tax > 0 ? `GST ${p.rateText} inside: ${inr(p.tax)} — nothing added on top` : 'No GST inside at 0%'
  return `+ GST ${p.rateText}: ${inr(p.tax)}`
}

export function SaleCharges({
  types,
  rows,
  priced,
  onChange,
  disabled,
  idPrefix,
}: {
  types: SaleChargeType[]
  rows: SaleChargeDraft[]
  /** Each priced row by its key (only rows with a type and a figure are priced). */
  priced: Map<string, PricedSaleCharge>
  onChange: (rows: SaleChargeDraft[]) => void
  disabled?: boolean
  /** For the boxes' labels: "Charge 1" on an order, "Quotation charge 1" on a quotation. */
  idPrefix?: string
}) {
  const typeById = new Map(types.map((t) => [t.id, t]))
  const set = (key: string, patch: Partial<SaleChargeDraft>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const label = idPrefix ?? 'Charge'

  if (types.length === 0) {
    return (
      <p className="text-muted-foreground py-1 text-xs">
        No sales charges set up yet. Add them under{' '}
        <a href="/masters/charges" target="_blank" rel="noreferrer" className="text-primary underline">
          Masters → Charges
        </a>{' '}
        with &quot;On sales&quot; ticked.
      </p>
    )
  }

  return (
    <div className="space-y-2 py-0.5">
      {rows.map((c, i) => {
        const taken = new Set(rows.filter((x) => x.key !== c.key).map((x) => x.chargeTypeId))
        const type = typeById.get(c.chargeTypeId)
        const p = priced.get(c.key)
        const treatment = c.treatment || type?.taxTreatment || 'INCLUSIVE'
        return (
          <div key={c.key} className="space-y-1">
            <div className="flex items-center gap-1.5">
              <SmartSelect
                className="form-input h-8 min-w-0 flex-1 text-xs"
                value={c.chargeTypeId}
                disabled={disabled}
                // A charge type picked starts with its own treatment from the master.
                onChange={(e) => set(c.key, { chargeTypeId: e.target.value, treatment: typeById.get(e.target.value)?.taxTreatment ?? 'INCLUSIVE' })}
                aria-label={`${label} ${i + 1}`}
              >
                <option value="">Charge…</option>
                {types
                  .filter((ct) => !taken.has(ct.id))
                  .map((ct) => (
                    <option key={ct.id} value={ct.id}>
                      {ct.name}
                    </option>
                  ))}
              </SmartSelect>
              <StepInput
                decimals
                className="form-input h-8 w-24 shrink-0 text-right text-xs tabular-nums"
                placeholder="Amount"
                value={c.amount}
                disabled={disabled}
                onValueChange={(v) => set(c.key, { amount: v })}
                aria-label={`${label} ${i + 1} amount`}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(rows.filter((x) => x.key !== c.key))}
                className="btn-ghost text-muted-foreground hover:text-destructive shrink-0 p-1"
                aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}
              >
                <Trash2 size={12} />
              </button>
            </div>
            {type && (
              <div className="flex items-center gap-2 pr-7">
                <SmartSelect
                  className="form-input h-7 w-[6.5rem] shrink-0 text-[11px]"
                  value={treatment}
                  disabled={disabled}
                  onChange={(e) => set(c.key, { treatment: e.target.value as ChargeTaxTreatment })}
                  aria-label={`${label} ${i + 1}: how GST sits on the amount`}
                  title="How GST sits on the amount typed"
                >
                  {(Object.keys(SHORT) as ChargeTaxTreatment[]).map((t) => (
                    <option key={t} value={t} data-sub={CHARGE_TAX_TREATMENT_LABEL[t]}>
                      {SHORT[t]}
                    </option>
                  ))}
                </SmartSelect>
                <span className="text-muted-foreground min-w-0 flex-1 text-right text-[11px] leading-tight tabular-nums">
                  {p ? chargeNote(p) : treatment === 'NON_TAXABLE' ? 'No GST' : treatment === 'INCLUSIVE' ? 'GST included in the amount' : 'GST added on top'}
                </span>
              </div>
            )}
          </div>
        )
      })}
      {rows.length < types.length && !disabled && (
        <button
          type="button"
          onClick={() => onChange([...rows, blankSaleCharge()])}
          className="text-muted-foreground hover:text-primary flex items-center gap-1 text-xs transition-colors"
        >
          <Plus size={12} /> Add charge
        </button>
      )}
    </div>
  )
}
