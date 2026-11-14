import { chargeEntryFields, resolveChargeConfigurations, type ChargeEntry, type ChargeResolveOptions } from './chargeConfiguration'
import { chargeSnapshot, type ChargeTaxSnapshot } from '@ld-erp/shared'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { CHARGE_TAX_TREATMENTS, priceSaleCharge, type ChargeTaxTreatment, type PricedSaleCharge, type SaleChargeInput, type SaleGoods } from '@ld-erp/shared'
import { AppError } from '../middleware/errorHandler'

/** Sales charges resolve server-side from their master or saved source snapshot.
 * All charge calculations use the shared engine. Goods inheritance is explicit;
 * new configurations default to GST-exclusive, with authorized overrides audited.
 */

export const chargeTreatmentSchema = z.enum(CHARGE_TAX_TREATMENTS as [ChargeTaxTreatment, ...ChargeTaxTreatment[]])

/** A charge row as a sales form sends it. */
export const saleChargeSchema = z.object({
  ...chargeEntryFields,
  chargeTypeId: z.string().min(1, 'Pick the charge'),
  amount: z.number().min(0, 'A charge cannot be negative'),
  /** Only for our own trims on a job-work invoice; any other charge's rate is worked out. */
  gstRate: z.number().min(0).max(100).optional().nullable(),
  /** How GST sits on the figure typed; the charge type's own when not sent. */
  taxTreatment: chargeTreatmentSchema.optional().nullable(),
})

export interface ChargeInput extends ChargeEntry {
  chargeTypeId: string
  amount: number
  gstRate?: number | null
  taxTreatment?: ChargeTaxTreatment | null
  /**
   * Our own trims billed on a job-work invoice: goods of their own, not a
   * cost of delivering the job work, so they keep their own rate (the
   * charge's, else the master's) with GST added on top, like a goods line.
   */
  ownMaterial?: boolean
}

/** A charge checked and ready to price: the engine's input, and whose it is. */
export type ResolvedCharge = SaleChargeInput & { chargeTypeId: string; ownMaterial: boolean; sortOrder: number; config: ChargeTaxSnapshot }

/**
 * Checks each charge against Masters → Charges (it exists, and is on for
 * sales) and settles how it is taxed. A row with nothing in it is dropped.
 * `treatmentByType`: what the order already said for a charge, so an invoice
 * bills the order's charge the way the order priced it when the form leaves
 * the treatment out.
 */
export async function resolveSaleCharges(
  tx: Prisma.TransactionClient,
  input: ChargeInput[] | undefined,
  opts: ChargeResolveOptions & { treatmentByType?: Map<string, ChargeTaxTreatment> } = {},
): Promise<ResolvedCharge[]> {
  const wanted = (input ?? []).filter(c => c.amount > 0)
  const configs = await resolveChargeConfigurations(tx, wanted, 'sales', opts)
  return configs.map((c, i) => {
    const ownMaterial = !!wanted[i].ownMaterial
    const config = { ...c.config }
    if (ownMaterial) { config.followsGoodsRate = false; config.treatment = 'EXCLUSIVE' }
    return { key: c.chargeTypeId, chargeTypeId: c.chargeTypeId, amount: c.amount,
      treatment: config.treatment, followsGoodsRate: config.followsGoodsRate, ownRate: config.ownRate,
      amountMode: config.amountMode, taxCategory: config.taxCategory, config, ownMaterial, sortOrder: i }
  })
}

/**
 * Priced charges as rows to save. `split`: an invoice keeps one row per rate,
 * so its tax table reads true; an order or a quotation keeps one row per
 * charge (one of each charge per document), carrying the tax of all its shares.
 */
export function chargeRows(resolved: ResolvedCharge[], priced: PricedSaleCharge[], { split = false }: { split?: boolean } = {}) {
  return priced.flatMap((p, i) => {
    const r = resolved[i]
    const base = { chargeTypeId: r.chargeTypeId, taxTreatment: p.treatment, sortOrder: r.sortOrder, taxSnapshot: { ...r.config, parts: p.parts } as unknown as Prisma.InputJsonValue }
    if (split && p.parts.length > 1) {
      return p.parts.map((part) => ({ ...base, amount: part.amount, netAmount: part.net, gstRate: part.gstRate, cgst: part.cgst, sgst: part.sgst, igst: part.igst }))
    }
    return [{ ...base, amount: p.amount, netAmount: p.net, gstRate: p.gstRate, cgst: p.cgst, sgst: p.sgst, igst: p.igst }]
  })
}

/** Checks and prices a document's charges against its goods, and gives the rows to save (an invoice's charges). */
export async function priceSalesCharges(
  tx: Prisma.TransactionClient,
  input: ChargeInput[] | undefined,
  isIntraState: boolean,
  goods: SaleGoods[],
  opts: ChargeResolveOptions & { split?: boolean; treatmentByType?: Map<string, ChargeTaxTreatment> } = {},
) {
  const resolved = await resolveSaleCharges(tx, input, opts)
  const priced = resolved.map((c) => priceSaleCharge(c, goods, isIntraState))
  return chargeRows(resolved, priced, opts)
}

type TaxRow = { taxable: number; cgst: number; sgst: number; igst: number }
type GoodsLine = TaxRow & { hsnCode: string | null; gstRate: number }
/** A saved charge row: its value without GST is what GST was worked out on, unless it carries none. */
export type ChargeRow = { taxSnapshot?: ChargeTaxSnapshot | null; name: string; gstRate: number; netAmount: number; treatment: ChargeTaxTreatment; cgst: number; sgst: number; igst: number }

/**
 * Where an invoice's charges sit in its HSN table. A charge taxed at the
 * goods' rate belongs to those goods' HSN codes, shared by their taxable
 * value; a charge at a rate no goods line carries (its own rate, or one billed
 * before 19 Oct 2026) keeps a row of its own, by name, marked `charge`. A
 * charge with no GST is outside the taxable value and has no place here. The
 * value is always the charge's value without GST, so a charge typed with GST
 * included adds its value, not its full figure.
 */
export function chargeShares(lines: GoodsLine[], charges: ChargeRow[]) {
  const out: Array<TaxRow & { key: string; hsn: string; rate: number; charge: boolean }> = []
  for (const c of charges) {
    if (c.treatment === 'NON_TAXABLE') continue
    if (c.taxSnapshot && !c.taxSnapshot.followsGoodsRate) {
      const hsn = c.taxSnapshot.hsnCode ?? c.name
      out.push({ key: `charge|${hsn}|${c.gstRate}|${c.taxSnapshot.taxCategory}`, hsn, rate: c.gstRate,
        taxable: c.netAmount, cgst: c.cgst, sgst: c.sgst, igst: c.igst, charge: true })
      continue
    }
    const goods = lines.filter((l) => l.gstRate === c.gstRate && l.taxable > 0)
    const base = goods.reduce((s, l) => s + l.taxable, 0)
    if (!(base > 0)) {
      out.push({ key: `charge|${c.name}|${c.gstRate}`, hsn: c.name, rate: c.gstRate, taxable: c.netAmount, cgst: c.cgst, sgst: c.sgst, igst: c.igst, charge: true })
      continue
    }
    for (const l of goods) {
      const share = l.taxable / base
      out.push({
        key: `${l.hsnCode ?? '—'}|${l.gstRate}`,
        hsn: l.hsnCode ?? '—',
        rate: l.gstRate,
        taxable: c.netAmount * share,
        cgst: c.cgst * share,
        sgst: c.sgst * share,
        igst: c.igst * share,
        charge: false,
      })
    }
  }
  return out
}

/** An invoice's HSN table: one row per HSN code and rate, its charges folded in (see chargeShares). */
export function foldChargesIntoHsn(lines: GoodsLine[], charges: ChargeRow[]) {
  const rows = new Map<string, TaxRow & { hsn: string; rate: number; charge: boolean }>()
  const add = (key: string, hsn: string, rate: number, v: TaxRow, charge: boolean) => {
    const r = rows.get(key) ?? { hsn, rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, charge }
    r.taxable += v.taxable
    r.cgst += v.cgst
    r.sgst += v.sgst
    r.igst += v.igst
    rows.set(key, r)
  }
  for (const l of lines) add(`${l.hsnCode ?? '—'}|${l.gstRate}`, l.hsnCode ?? '—', l.gstRate, l, false)
  for (const c of chargeShares(lines, charges)) add(c.key, c.hsn, c.rate, c, c.charge)
  return [...rows.values()]
}

/** A saved charge row in the shape chargeShares reads. */
export function chargeRowOf(c: {
  taxSnapshot?: unknown
  chargeType: { name: string }
  gstRate: Prisma.Decimal | number
  amount: Prisma.Decimal | number
  /** Empty on a charge saved before charges had a treatment: GST was added on top, so its amount. */
  netAmount: Prisma.Decimal | number | null
  taxTreatment: ChargeTaxTreatment
  cgst: Prisma.Decimal | number
  sgst: Prisma.Decimal | number
  igst: Prisma.Decimal | number
}): ChargeRow {
  return {
    taxSnapshot: chargeSnapshot(c.taxSnapshot),
    name: chargeSnapshot(c.taxSnapshot)?.name ?? c.chargeType.name,
    gstRate: Number(c.gstRate),
    netAmount: Number(c.netAmount ?? c.amount),
    treatment: c.taxTreatment,
    cgst: Number(c.cgst),
    sgst: Number(c.sgst),
    igst: Number(c.igst),
  }
}
