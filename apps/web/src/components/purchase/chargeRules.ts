import type { ChargeTaxCategory, ChargeTaxSnapshot, GstSplit, PricedCharge } from '@ld-erp/shared'
import type { HsnOption } from './TaxBreakdown'

/**
 * What a purchase charge's GST column says: the rate, and where it comes from.
 *
 * The screen only ever describes the configuration that is actually applied —
 * the one priced and sent — never a choice still being made. That was the
 * 25 Nov 2026 bug: an unapplied "Inherit from goods" sat in view while the
 * charge was still priced at the master's 5%.
 */
export function chargeGstLabel(
  config: ChargeTaxSnapshot,
  priced: Pick<PricedCharge, 'gstRate' | 'parts' | 'tax'> | undefined,
  split: GstSplit | null
): { rate: string; source: string; changed: boolean } {
  if (split === 'NONE') return { rate: 'No GST', source: 'No GST — supplier not registered', changed: false }
  const reason = config.overrideReason?.trim()
  const changed = Boolean(reason)
  const noGst =
    config.gstApplicable === false ||
    config.treatment === 'NON_TAXABLE' ||
    !['TAXABLE', 'UNSPECIFIED'].includes(config.taxCategory)
  if (noGst) return { rate: 'No GST', source: changed ? `Changed: ${reason}` : '', changed }

  const rates = [...new Set((priced?.parts ?? []).map((p) => p.gstRate))].sort((a, b) => a - b)
  // Before an amount is typed nothing is priced: show the rate it will take.
  // A charge that follows the goods has none of its own until it is priced.
  const rate = rates.length
    ? rates.map((r) => `${r}%`).join(' / ')
    : config.followsGoodsRate
      ? 'goods’ rate'
      : `${config.ownRate}%`
  const source = changed
    ? `Changed: ${reason}`
    : config.followsGoodsRate
      ? 'follows the goods'
      : config.hsnCode
        ? `HSN / SAC ${config.hsnCode}`
        : 'Masters → Charges'
  return { rate, source, changed }
}

/** What the "Change tax" window edits. */
export type ChargeTaxDraft = {
  mode: 'INHERIT' | 'HSN' | 'MANUAL' | 'NONE'
  hsnCodeId: string | null
  ownRate: number
  treatment: 'INCLUSIVE' | 'EXCLUSIVE'
  taxCategory: ChargeTaxCategory
  reason: string
}

/** The window's starting point: the charge as it is priced now, with a blank reason. */
export function draftFromConfig(config: ChargeTaxSnapshot): ChargeTaxDraft {
  const mode =
    config.gstApplicable === false || config.treatment === 'NON_TAXABLE'
      ? 'NONE'
      : config.followsGoodsRate
        ? 'INHERIT'
        : config.hsnCodeId
          ? 'HSN'
          : 'MANUAL'
  return {
    mode,
    hsnCodeId: config.hsnCodeId,
    ownRate: Number(config.ownRate) || 0,
    treatment: config.treatment === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE',
    taxCategory: config.taxCategory,
    reason: '',
  }
}

/**
 * The configuration a draft makes — built the way the server builds it from
 * the same override (apps/api/src/services/chargeConfiguration.ts), so the
 * figure previewed is the figure saved.
 */
export function configFromDraft(base: ChargeTaxSnapshot, d: ChargeTaxDraft, hsn: HsnOption[]): ChargeTaxSnapshot {
  const code = d.mode === 'HSN' ? hsn.find((h) => h.id === d.hsnCodeId) : undefined
  return {
    ...base,
    gstApplicable: true,
    applicabilityOverride: false,
    treatment: d.mode === 'NONE' ? 'NON_TAXABLE' : d.treatment,
    followsGoodsRate: d.mode === 'INHERIT',
    ownRate: d.mode === 'NONE' ? 0 : code ? Number(code.gstRate) : d.ownRate,
    hsnCodeId: code?.id ?? null,
    hsnCode: code?.code ?? null,
    taxCategory: d.taxCategory,
    overrideReason: d.reason.trim(),
  }
}

/** Why the server would refuse this change, or null when it would take it. */
export function taxDraftProblem(d: ChargeTaxDraft): string | null {
  if (d.mode === 'HSN' && !d.hsnCodeId) return 'Pick an HSN / SAC code.'
  if (d.taxCategory === 'UNSPECIFIED') return 'Choose a tax classification.'
  if (d.mode === 'NONE' && d.taxCategory === 'TAXABLE')
    return 'A charge without GST is exempt, nil-rated or non-GST — not taxable.'
  if (d.reason.trim().length < 5) return 'Say why the tax is being changed (5 letters or more).'
  return null
}
