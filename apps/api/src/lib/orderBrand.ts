import { Prisma, prisma } from '@ld-erp/database'

type Db = typeof prisma | Prisma.TransactionClient

/** The own brand an order is made under: LD Cotton Mills, VHAGAR… */
export type OrderBrand = { name: string; type: string } | null

const pick = { select: { name: true, type: true } } as const

/**
 * The brand every document made for an order carries, from start to end —
 * its manufacturing order's (which follows the sales order's), else the sales
 * order's, else the order behind an invoice. None for stock not made for an
 * order (a general requisition, say).
 */
export async function orderBrand(db: Db, ref: { moId?: string | null; soId?: string | null; invoiceId?: string | null }): Promise<OrderBrand> {
  if (ref.moId) {
    const mo = await db.manufacturingOrder.findUnique({ where: { id: ref.moId }, select: { brand: pick } })
    if (mo) return mo.brand
  }
  if (ref.soId) {
    const so = await db.salesOrder.findUnique({ where: { id: ref.soId }, select: { brand: pick } })
    if (so) return so.brand
  }
  if (ref.invoiceId) {
    const inv = await db.salesInvoice.findUnique({ where: { id: ref.invoiceId }, select: { so: { select: { brand: pick } } } })
    return inv?.so?.brand ?? null
  }
  return null
}
