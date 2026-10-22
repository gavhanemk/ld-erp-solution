import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

const round2 = (n: number) => Math.round(n * 100) / 100

export interface ChargeInput {
  chargeTypeId: string
  amount: number
  /** Only for our own trims on a job-work invoice; any other charge takes the goods' rate. */
  gstRate?: number | null
  /**
   * Our own trims billed on a job-work invoice: goods of their own, not a
   * cost of delivering the job work, so they keep their own rate (the
   * charge's, else the master's) as they always have.
   */
  ownMaterial?: boolean
}

/** The goods a charge goes with: each line's taxable value and its GST rate. */
export interface GoodsAtRate {
  taxable: number
  gstRate: number
}

/**
 * A charge billed with the goods — transport, freight, packing — is part of
 * what the goods are sold for (CGST Act s.15(2)(c)), so it is taxed at the
 * goods' rate, not at a rate of its own (the business's answer of 19 Oct
 * 2026). When the goods carry more than one rate, the charge is shared out
 * across them by the goods' taxable value, the biggest share taking any
 * rounding paisa. Only with no goods to follow does it fall back on the rate
 * in Masters → Charges. The forms do the same sums (components/sales/chargeShare.ts).
 */
export function shareByRate(amount: number, goods: GoodsAtRate[], fallbackRate: number) {
  const byRate = new Map<number, number>()
  for (const g of goods) if (g.taxable > 0) byRate.set(g.gstRate, (byRate.get(g.gstRate) ?? 0) + g.taxable)
  const total = [...byRate.values()].reduce((s, v) => s + v, 0)
  if (!(total > 0)) return [{ amount, gstRate: fallbackRate }]
  const parts = [...byRate.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([gstRate, taxable]) => ({ gstRate, amount: round2((amount * taxable) / total) }))
  const drift = round2(amount - parts.reduce((s, p) => s + p.amount, 0))
  if (drift !== 0) parts[0].amount = round2(parts[0].amount + drift)
  return parts.filter((p) => p.amount !== 0)
}

/**
 * Prices the charges on a sales document — transport, freight, packing.
 *
 * One road for the order and the invoice, so a charge is taxed the same way
 * on both. Each comes from Masters → Charges and must be switched on for
 * sales; each is taxed at the goods' rate (see shareByRate), split CGST + SGST
 * inside the state and IGST outside it. A row with nothing in it is dropped.
 *
 * `split`: an invoice keeps one row per rate, so its tax table reads true; an
 * order keeps one row per charge (one of each charge per order), carrying the
 * tax of all its shares.
 */
export async function priceSalesCharges(
  tx: Prisma.TransactionClient,
  input: ChargeInput[] | undefined,
  isIntraState: boolean,
  goods: GoodsAtRate[],
  { split = false }: { split?: boolean } = {},
) {
  const wanted = (input ?? []).filter((c) => c.amount > 0)
  const types = wanted.length
    ? await tx.chargeType.findMany({
        where: { id: { in: wanted.map((c) => c.chargeTypeId) } },
        select: { id: true, name: true, defaultGstRate: true, isActive: true, applyOnSale: true },
      })
    : []
  const typeById = new Map(types.map((t) => [t.id, t]))

  return wanted.flatMap((c, i) => {
    const type = typeById.get(c.chargeTypeId)
    if (!type) throw new AppError('One of the charges does not exist', 400, 'BAD_CHARGE')
    if (!type.isActive || !type.applyOnSale) {
      throw new AppError(`${type.name} is not a sales charge. Turn it on for sales under Masters → Charges.`, 400, 'BAD_CHARGE')
    }
    const amount = round2(c.amount)
    const shares = c.ownMaterial
      ? [{ amount, gstRate: c.gstRate ?? Number(type.defaultGstRate) }]
      : shareByRate(amount, goods, Number(type.defaultGstRate))
    const parts = shares.map((p) => {
      const tax = (p.amount * p.gstRate) / 100
      return {
        ...p,
        cgst: isIntraState ? round2(tax / 2) : 0,
        sgst: isIntraState ? round2(tax / 2) : 0,
        igst: isIntraState ? 0 : round2(tax),
      }
    })
    if (split) return parts.map((p) => ({ chargeTypeId: type.id, ...p, sortOrder: i }))
    const cgst = round2(parts.reduce((s, p) => s + p.cgst, 0))
    const sgst = round2(parts.reduce((s, p) => s + p.sgst, 0))
    const igst = round2(parts.reduce((s, p) => s + p.igst, 0))
    // One rate, or the rate all its shares come to together.
    const gstRate = parts.length === 1 ? parts[0].gstRate : round2(((cgst + sgst + igst) / amount) * 100)
    return [{ chargeTypeId: type.id, amount, gstRate, cgst, sgst, igst, sortOrder: i }]
  })
}

type TaxRow = { taxable: number; cgst: number; sgst: number; igst: number }
type GoodsLine = TaxRow & { hsnCode: string | null; gstRate: number }
type ChargeRow = { name: string; gstRate: number; amount: number; cgst: number; sgst: number; igst: number }

/**
 * Where an invoice's charges sit in its HSN table. A charge taxed at the
 * goods' rate belongs to those goods' HSN codes, shared by their taxable
 * value. A charge at a rate no goods line carries (one billed before 19 Oct
 * 2026, at the charge's own rate) keeps a row of its own, by name, marked
 * `charge`.
 */
export function chargeShares(lines: GoodsLine[], charges: ChargeRow[]) {
  const out: Array<TaxRow & { key: string; hsn: string; rate: number; charge: boolean }> = []
  for (const c of charges) {
    const goods = lines.filter((l) => l.gstRate === c.gstRate && l.taxable > 0)
    const base = goods.reduce((s, l) => s + l.taxable, 0)
    if (!(base > 0)) {
      out.push({ key: `charge|${c.name}|${c.gstRate}`, hsn: c.name, rate: c.gstRate, taxable: c.amount, cgst: c.cgst, sgst: c.sgst, igst: c.igst, charge: true })
      continue
    }
    for (const l of goods) {
      const share = l.taxable / base
      out.push({
        key: `${l.hsnCode ?? '—'}|${l.gstRate}`,
        hsn: l.hsnCode ?? '—',
        rate: l.gstRate,
        taxable: c.amount * share,
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
