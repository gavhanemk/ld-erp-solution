'use client'

import { ChargeTaxDetails, taxOverridePayload } from '../purchase/ChargeTaxDetails'
import { chargeConfigOf, savedChargeConfig, type ChargeMasterConfig, type ChargeTaxSnapshot } from '@ld-erp/shared'

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

export interface SaleChargeType extends ChargeMasterConfig {
  id: string
  name: string
  defaultGstRate: string | number
  isActive: boolean
  applyOnSale: boolean
  taxTreatment?: ChargeTaxTreatment
  followsGoodsRate?: boolean
}

export interface SaleChargeDraft {
  sourceChargeId?: string
  config?: ChargeTaxSnapshot
  taxOverride?: ChargeTaxSnapshot
  amountMode?: 'FIXED' | 'PERCENT'
  key: string
  chargeTypeId: string
  amount: string
  /** '' until a charge type is picked; then its type's own, unless changed here. */
  treatment: ChargeTaxTreatment | ''
}

let chargeKey = 0
export const blankSaleCharge = (): SaleChargeDraft => ({ key: `ch${++chargeKey}`, chargeTypeId: '', amount: '', treatment: '' })

/** A saved document's charges, back into the box. */
export function chargeDraftsOf(saved: Array<{ id?: string; taxSnapshot?: unknown; gstRate?: string | number; chargeType?: { name: string } | null; chargeTypeId: string; amount: string | number; taxTreatment?: ChargeTaxTreatment | null }> | undefined): SaleChargeDraft[] {
  return (saved ?? []).map((c) => ({
    key: `ch${++chargeKey}`,
    chargeTypeId: c.chargeTypeId,
    amount: String(savedChargeConfig({ ...c, gstRate: c.gstRate ?? 0 }).inputAmount),
    config: savedChargeConfig({ ...c, gstRate: c.gstRate ?? 0 }), sourceChargeId: c.id,
    amountMode: savedChargeConfig({ ...c, gstRate: c.gstRate ?? 0 }).amountMode,
    // A charge saved before charges said how GST sits on them had GST added on top.
    treatment: c.taxTreatment ?? 'EXCLUSIVE',
  }))
}

/** What the engine prices: the rows with a type and a figure, each with its treatment settled. */
export function chargesToPrice(rows: SaleChargeDraft[], typeById: Map<string, SaleChargeType>): TotalsCharge[] {
  return rows.flatMap((c) => {
    const type = typeById.get(c.chargeTypeId)
    const amount = Number(c.amount) || 0
    if ((!type && !c.config) || !(amount > 0)) return []
    const config = c.taxOverride ?? c.config ?? chargeConfigOf(type!, 'sales')
    return [
      {
        key: c.key,
        amount,
        treatment: config.treatment, followsGoodsRate: config.followsGoodsRate, ownRate: config.ownRate,
        amountMode: c.amountMode ?? 'FIXED', taxCategory: config.taxCategory,
      },
    ]
  })
}

/** What the server is sent. */
export function chargesToSave(rows: SaleChargeDraft[], typeById: Map<string, SaleChargeType>) {
  return chargesToPrice(rows, typeById).map(c => {
    const row = rows.find(r => r.key === c.key)!
    return { chargeTypeId: row.chargeTypeId, amount: c.amount, amountMode: row.amountMode ?? 'FIXED',
      sourceChargeId: row.sourceChargeId, taxOverride: taxOverridePayload(row.taxOverride) }
  })
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

  if (types.length === 0 && rows.length === 0) {
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
        const config = { ...(c.taxOverride ?? c.config ?? chargeConfigOf(type ?? { name: 'Charge', defaultGstRate: 0 }, 'sales')), amountMode: c.amountMode ?? 'FIXED' as const, inputAmount: Number(c.amount) || 0 }
        return (
          <div key={c.key} className="space-y-1">
            <div className="flex items-center gap-1.5">
              <SmartSelect
                className="form-input h-8 min-w-0 flex-1 text-xs"
                value={c.chargeTypeId}
                disabled={disabled}
                // A charge type picked starts with its own treatment from the master.
                onChange={(e) => set(c.key, { chargeTypeId: e.target.value, treatment: '', config: undefined, taxOverride: undefined, sourceChargeId: undefined })}
                aria-label={`${label} ${i + 1}`}
              >
                <option value="">Charge…</option>
                {!type && c.config && <option value={c.chargeTypeId}>{c.config.name} (saved)</option>}
                {types
                  .filter((ct) => !taken.has(ct.id))
                  .map((ct) => (
                    <option key={ct.id} value={ct.id}>
                      {ct.id === c.chargeTypeId ? c.config?.name ?? ct.name : ct.name}
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
            {(type || c.config) && (
              <div>
                <div className="flex justify-end gap-1" role="group" aria-label={`${label} ${i + 1} amount type`}>
                  {(['FIXED', 'PERCENT'] as const).map(mode => <button type="button" key={mode} disabled={disabled} aria-pressed={(c.amountMode ?? 'FIXED') === mode} className="btn-ghost px-2 text-xs" onClick={() => set(c.key, { amountMode: mode })}>{mode === 'FIXED' ? '₹' : '%'}</button>)}
                </div>
                <ChargeTaxDetails config={config} priced={p ? { ...p, amount: p.net } : undefined}
                  onOverride={disabled ? undefined : value => set(c.key, { taxOverride: value })} />
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
