import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { chargeConfigOf, chargeSnapshot, type ChargeTaxSnapshot } from '@ld-erp/shared'
import { AppError } from '../middleware/errorHandler'

export const chargeEntryFields = {
  sourceChargeId: z.string().optional(),
  amountMode: z.enum(['FIXED', 'PERCENT']).optional(),
  taxOverride: z
    .object({
      mode: z.enum(['HSN', 'MANUAL', 'NONE', 'INHERIT']),
      treatment: z.enum(['INCLUSIVE', 'EXCLUSIVE', 'NON_TAXABLE']),
      hsnCodeId: z.string().nullable().optional(),
      gstRate: z.number().finite().min(0).max(100),
      taxCategory: z.enum(['TAXABLE', 'EXEMPT', 'NIL_RATED', 'NON_GST']),
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
}

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
      const saved = c.sourceChargeId
        ? candidates.find((s) => s.id === c.sourceChargeId)
        : candidates.length === 1
          ? candidates[0]
          : undefined
      if (c.sourceChargeId && !saved)
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
      if (!saved && config.hsnCodeId) {
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
            'Changing charge tax requires Masters edit permission.',
            403,
            'CHARGE_TAX_FORBIDDEN'
          )
        const o = c.taxOverride
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
          treatment: o.mode === 'NONE' ? 'NON_TAXABLE' : o.treatment,
          followsGoodsRate: o.mode === 'INHERIT',
          ownRate: o.mode === 'NONE' ? 0 : Number(hsn?.gstRate ?? o.gstRate),
          hsnCodeId: hsn?.id ?? null,
          hsnCode: hsn?.code ?? null,
          taxCategory: o.taxCategory,
          overrideReason: o.reason,
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
