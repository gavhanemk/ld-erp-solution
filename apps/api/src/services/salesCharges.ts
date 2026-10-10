import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

const round2 = (n: number) => Math.round(n * 100) / 100

export interface ChargeInput {
  chargeTypeId: string
  amount: number
  /** The GST on this charge; the charge master's rate when not sent. */
  gstRate?: number | null
}

/**
 * Prices the charges on a sales document — transport, freight, packing.
 *
 * One road for the order and the invoice, so a charge is taxed the same way
 * on both. Each comes from Masters → Charges and must be switched on for
 * sales; each carries its own GST, split CGST + SGST inside the state and
 * IGST outside it. A row with nothing in it is dropped.
 */
export async function priceSalesCharges(tx: Prisma.TransactionClient, input: ChargeInput[] | undefined, isIntraState: boolean) {
  const wanted = (input ?? []).filter((c) => c.amount > 0)
  const types = wanted.length
    ? await tx.chargeType.findMany({
        where: { id: { in: wanted.map((c) => c.chargeTypeId) } },
        select: { id: true, name: true, defaultGstRate: true, isActive: true, applyOnSale: true },
      })
    : []
  const typeById = new Map(types.map((t) => [t.id, t]))

  return wanted.map((c, i) => {
    const type = typeById.get(c.chargeTypeId)
    if (!type) throw new AppError('One of the charges does not exist', 400, 'BAD_CHARGE')
    if (!type.isActive || !type.applyOnSale) {
      throw new AppError(`${type.name} is not a sales charge. Turn it on for sales under Masters → Charges.`, 400, 'BAD_CHARGE')
    }
    const amount = round2(c.amount)
    const gstRate = c.gstRate ?? Number(type.defaultGstRate)
    const tax = (amount * gstRate) / 100
    return {
      chargeTypeId: type.id,
      amount,
      gstRate,
      cgst: isIntraState ? round2(tax / 2) : 0,
      sgst: isIntraState ? round2(tax / 2) : 0,
      igst: isIntraState ? 0 : round2(tax),
      sortOrder: i,
    }
  })
}
