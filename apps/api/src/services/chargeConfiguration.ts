import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { chargeConfigOf, chargeSnapshot, type ChargeTaxSnapshot, type ChargeTaxSetting } from '@ld-erp/shared'
import { AppError } from '../middleware/errorHandler'

export const chargeEntryFields = {
  sourceChargeId: z.string().optional(),
  amountMode: z.enum(['FIXED', 'PERCENT']).optional(),
  /**
   * A charge taken off a saved document and added again (25 Nov 2026): it is
   * a new entry, so it takes today's master setting rather than the saved
   * row's. Without it a charge of a type the document already had is matched
   * to that saved row and keeps the rate it was saved with.
   */
  fresh: z.boolean().optional(),
  taxOverride: z
    .object({
      gstApplicable: z.boolean().optional(),
      applicabilityOnly: z.boolean().optional(),
      mode: z.enum(['HSN', 'MANUAL', 'NONE', 'INHERIT']),
      treatment: z.enum(['INCLUSIVE', 'EXCLUSIVE', 'NON_TAXABLE']),
      hsnCodeId: z.string().nullable().optional(),
      gstRate: z.number().finite().min(0).max(100),
      taxCategory: z.enum(['TAXABLE', 'EXEMPT', 'NIL_RATED', 'NON_GST', 'UNSPECIFIED']),
      reason: z.string().trim().min(5, 'Explain the tax override').max(300),
    })
    .optional(),
}
const entrySchema = z.object({
  chargeTypeId: z.string(),
  amount: z.number().finite().min(0),
  ...chargeEntryFields,
})
export type ChargeEntry = z.infer<typeof entrySchema>
export interface SavedChargeConfig {
  id?: string
  chargeTypeId: string
  taxSnapshot?: unknown
  amount: unknown
  gstRate: unknown
  taxTreatment?: 'INCLUSIVE' | 'EXCLUSIVE' | 'NON_TAXABLE'
  gstMode?: string
  hsnCodeId?: string | null
  hsnCode?: { code: string } | null
  chargeType?: { name: string } | null
}
export interface ChargeResolveOptions {
  saved?: SavedChargeConfig[]
  canOverride?: boolean
  /** Whoever saves the document: an override records them. */
  by?: { id: string } | null
}

/** A charge's GST as a setting, for an override's record. */
const settingOf = (c: ChargeTaxSnapshot): ChargeTaxSetting => ({
  gstApplicable: c.gstApplicable !== false && c.treatment !== 'NON_TAXABLE',
  treatment: c.treatment,
  followsGoodsRate: c.followsGoodsRate,
  ownRate: c.ownRate,
  hsnCode: c.hsnCode,
  taxCategory: c.taxCategory,
})

/** Only server-loaded source rows can supply a historical configuration. */
export async function resolveChargeConfigurations(
  tx: Prisma.TransactionClient,
  input: ChargeEntry[],
  side: 'sales' | 'purchase',
  opts: ChargeResolveOptions = {}
) {
  const types = await tx.chargeType.findMany({
    where: { id: { in: [...new Set(input.map((c) => c.chargeTypeId))] } },
    include: { defaultHsnCode: true, salesHsnCode: true },
  })
  const byId = new Map(types.map((t) => [t.id, t]))
  return Promise.all(
    input.map(async (c) => {
      const type = byId.get(c.chargeTypeId)
      if (!type) throw new AppError('That charge no longer exists.', 400, 'INVALID_CHARGE')
      const candidates = (opts.saved ?? []).filter((s) => s.chargeTypeId === c.chargeTypeId)
      const saved = c.fresh
        ? undefined
        : c.sourceChargeId
          ? candidates.find((s) => s.id === c.sourceChargeId)
          : candidates.length === 1
            ? candidates[0]
            : undefined
      if (c.sourceChargeId && !c.fresh && !saved)
        throw new AppError(
          'This charge does not belong to the linked document.',
          400,
          'INVALID_CHARGE_SOURCE'
        )
      if (
        !saved &&
        (!type.isActive || !(side === 'sales' ? type.applyOnSale : type.applyOnPurchase))
      ) {
        throw new AppError(
          `${type.name} is not available on ${side} documents.`,
          400,
          'INVALID_CHARGE'
        )
      }
      const previous = chargeSnapshot(saved?.taxSnapshot)
      let config: ChargeTaxSnapshot = previous
        ? { ...previous }
        : saved
          ? {
              version: 1,
              name: saved.chargeType?.name ?? type.name,
              treatment: saved.taxTreatment ?? 'EXCLUSIVE',
              followsGoodsRate: false,
              ownRate: Number(saved.gstRate),
              hsnCodeId: saved.hsnCodeId ?? null,
              hsnCode: saved.hsnCode?.code ?? null,
              taxCategory: 'UNSPECIFIED',
              amountMode: 'FIXED',
              inputAmount: Number(saved.amount),
              basis: 'GOODS_AFTER_DISCOUNT',
            }
          : chargeConfigOf(
              {
                ...type,
                defaultGstRate: Number(type.defaultGstRate),
                defaultHsnCode: type.defaultHsnCode
                  ? { ...type.defaultHsnCode, gstRate: Number(type.defaultHsnCode.gstRate) }
                  : null,
                salesHsnCode: type.salesHsnCode
                  ? { ...type.salesHsnCode, gstRate: Number(type.salesHsnCode.gstRate) }
                  : null,
              },
              side
            )
      if (
        !saved &&
        config.hsnCodeId &&
        (c.taxOverride?.gstApplicable ?? config.gstApplicable) !== false
      ) {
        const hsn = side === 'sales' ? type.salesHsnCode : type.defaultHsnCode
        if (!hsn?.isActive)
          throw new AppError(
            `Review the HSN / SAC for ${type.name} in Extra Charges.`,
            400,
            'INVALID_CHARGE_HSN'
          )
        if (hsn.priceLimit != null)
          throw new AppError(
            `${type.name} uses a price-dependent HSN. Configure a charge classification with a single applicable rate.`,
            400,
            'AMBIGUOUS_CHARGE_HSN'
          )
      }
      if (c.taxOverride) {
        if (!opts.canOverride)
          throw new AppError(
            side === 'sales'
              ? 'Changing a charge’s GST on a sales document needs the “Override Sales Charge GST” permission (Settings → People).'
              : 'Changing charge tax requires Masters edit permission.',
            403,
            'CHARGE_TAX_FORBIDDEN'
          )
        const o = c.taxOverride
        const was = settingOf(config)
        if (o.applicabilityOnly) {
          config = {
            ...config,
            gstApplicable: o.gstApplicable ?? true,
            treatment:
              o.gstApplicable && config.treatment === 'NON_TAXABLE'
                ? 'EXCLUSIVE'
                : config.treatment,
            overrideReason: o.reason,
          }
        } else {
          if (o.taxCategory === 'UNSPECIFIED')
            throw new AppError(
              'Choose a tax classification for this override.',
              400,
              'CHARGE_CLASSIFICATION_REQUIRED'
            )
          if (o.mode === 'NONE' && o.taxCategory === 'TAXABLE')
            throw new AppError(
              'Classify a charge without GST as exempt, nil-rated or non-GST.',
              400,
              'CHARGE_CLASSIFICATION_REQUIRED'
            )
          const hsn =
            o.mode === 'HSN' && o.hsnCodeId
              ? await tx.hsnCode.findUnique({ where: { id: o.hsnCodeId } })
              : null
          if (o.mode === 'HSN' && (!hsn?.isActive || hsn.priceLimit != null))
            throw new AppError(
              'Choose an active HSN / SAC with a single rate.',
              400,
              'INVALID_CHARGE_HSN'
            )
          config = {
            ...config,
            gstApplicable: o.gstApplicable ?? true,
            treatment: o.mode === 'NONE' ? 'NON_TAXABLE' : o.treatment,
            followsGoodsRate: o.mode === 'INHERIT',
            ownRate: o.mode === 'NONE' ? 0 : Number(hsn?.gstRate ?? o.gstRate),
            hsnCodeId: hsn?.id ?? null,
            hsnCode: hsn?.code ?? null,
            taxCategory: o.taxCategory,
            overrideReason: o.reason,
          }
        }
        // Kept on the charge, beside every earlier one: who, when, why, and what it was.
        const now = settingOf(config)
        if (JSON.stringify(now) !== JSON.stringify(was)) {
          const byName = opts.by?.id ? ((await tx.user.findUnique({ where: { id: opts.by.id }, select: { name: true } }))?.name ?? null) : null
          config.overrides = [...(previous?.overrides ?? []), { at: new Date().toISOString(), by: opts.by?.id ?? null, byName, reason: o.reason.trim(), from: was, to: now }]
        }
      }
      config.amountMode = c.amountMode ?? previous?.amountMode ?? 'FIXED'
      config.inputAmount = c.amount
      if (config.amountMode === 'PERCENT' && c.amount > 100)
        throw new AppError('A percentage charge cannot exceed 100%.', 400, 'INVALID_CHARGE_PERCENT')
      return { chargeTypeId: c.chargeTypeId, amount: c.amount, config }
    })
  )
}
