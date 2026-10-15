import { prisma, type Prisma } from '@ld-erp/database'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'

/*
 * Buyer stickers: the barcode sticker a buyer's brand wants on goods made for
 * them — SleepZ for Raymond Lifestyle — one per garment or one per pack.
 *
 * What is the buyer's for every order (their brand, who markets it, where
 * consumers complain, the barcode pattern, the number at the bottom, how each
 * size is worded) is kept on the customer. What changes with the garment
 * (article and colour code, product, MRP, pieces per pack) is kept on the
 * sales order line. The barcode itself is built from the pattern when the
 * sticker prints, so nothing is typed per size.
 */

/** As on the buyer's own stickers: X03AEAA00014-M826100 — size 03, article, colour, year 26, then 100. */
export const DEFAULT_PATTERN = 'X{size}{article}-{colour}{yy}100'

const text = (max: number) => z.string().trim().max(max).default('')

export const profileSchema = z.object({
  brand: text(60),
  marketedBy: text(400),
  complaints: text(600),
  tollFree: text(60),
  email: text(120),
  website: text(120),
  barcodePattern: z.string().trim().min(1, 'Give the barcode pattern').max(80).default(DEFAULT_PATTERN),
  /** The number at the bottom right: the buyer's PO number, a fixed number, or nothing. */
  refSource: z.enum(['PO', 'FIXED', 'NONE']).default('PO'),
  refValue: text(40),
  /** How each size is worded: "42 cm (CHEST)", and the buyer's own size, "L". */
  sizes: z.record(z.object({ text: text(40), ref: text(20) })).default({}),
})
export type LabelProfile = z.infer<typeof profileSchema>

export const lineInfoSchema = z.object({
  article: text(40),
  colour: text(20),
  product: text(60),
  mrp: z.number().min(0).max(10_000_000).nullable().default(null),
  /** 1 for a sticker on each garment; more for one sticker on a pack. */
  packQty: z.number().int().min(1, 'At least one piece to a sticker').max(1000).default(1),
})
export type LabelLineInfo = z.infer<typeof lineInfoSchema>

export const saveSchema = z.object({
  profile: profileSchema,
  lines: z.array(z.object({ soLineId: z.string().min(1), info: lineInfoSchema })).max(200),
})

async function orderOf(moId: string) {
  const mo = await prisma.manufacturingOrder.findUnique({
    where: { id: moId },
    select: {
      id: true,
      moNumber: true,
      so: {
        select: {
          id: true,
          soNumber: true,
          customerPORef: true,
          customer: {
            select: { id: true, name: true, email: true, billingAddress: true, billingCity: true, billingState: true, billingPincode: true, labelProfile: true },
          },
        },
      },
      lines: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          color: true,
          sizes: { select: { sizeId: true, qty: true } },
          style: {
            select: {
              code: true,
              name: true,
              mrp: true,
              sizeGroup: { select: { name: true, sizes: { orderBy: { sequence: 'asc' }, select: { id: true, code: true, label: true } } } },
            },
          },
          soLine: { select: { id: true, itemId: true, styleCode: true, printName: true, labelInfo: true, item: { select: { code: true, name: true } } } },
        },
      },
    },
  })
  if (!mo) throw new AppError('That manufacturing order does not exist', 404, 'NOT_FOUND')
  if (!mo.so) throw new AppError(`${mo.moNumber} is made for stock. Buyer stickers are for a customer's order.`, 400, 'NO_CUSTOMER')
  return mo as typeof mo & { so: NonNullable<typeof mo.so> }
}

/** Everything the buyer stickers of one order need, saved details over sensible starting ones. */
export async function buyerLabelsOf(moId: string) {
  const mo = await orderOf(moId)
  const c = mo.so.customer
  const [packedRows, lastReceipt] = await Promise.all([
    prisma.finishedGoodsReceiptLine.groupBy({
      by: ['itemId', 'sizeId'],
      where: { receipt: { moId: mo.id, cancelledAt: null }, grade: 'A' },
      _sum: { qty: true },
    }),
    prisma.finishedGoodsReceipt.findFirst({ where: { moId: mo.id, cancelledAt: null }, orderBy: { receiptDate: 'desc' }, select: { receiptDate: true } }),
  ])
  const packed = new Map(packedRows.map((r) => [`${r.itemId}|${r.sizeId ?? ''}`, Number(r._sum.qty ?? 0)]))

  const saved = profileSchema.safeParse(c.labelProfile ?? {})
  const base = saved.success ? saved.data : profileSchema.parse({})
  const profile: LabelProfile = {
    ...base,
    marketedBy: base.marketedBy || [c.name.toUpperCase(), [c.billingAddress, c.billingCity, c.billingState, c.billingPincode].filter(Boolean).join(', ')].filter(Boolean).join('\n'),
    email: base.email || c.email || '',
  }

  const lines = mo.lines
    .filter((l) => l.soLine)
    .map((l) => {
      const so = l.soLine!
      const group = l.style.sizeGroup?.sizes ?? []
      const ordered = new Map(l.sizes.map((s) => [s.sizeId, s.qty]))
      const sizes = group
        .map((z, i) => ({
          sizeId: z.id,
          code: z.code,
          label: z.label,
          // Its place in the size run: S 01, M 02 … — the buyer's size number.
          position: i + 1,
          ordered: ordered.get(z.id) ?? 0,
          packed: packed.get(`${so.itemId}|${z.id}`) ?? 0,
          text: profile.sizes[z.id]?.text || z.label || z.code,
          ref: profile.sizes[z.id]?.ref ?? '',
        }))
        .filter((z) => z.ordered > 0 || z.packed > 0)
      const savedInfo = lineInfoSchema.safeParse(so.labelInfo ?? {})
      const info: LabelLineInfo = savedInfo.success && so.labelInfo
        ? savedInfo.data
        : { article: so.styleCode ?? l.style.code, colour: '', product: so.printName || l.style.name, mrp: l.style.mrp == null ? null : Number(l.style.mrp), packQty: 1 }
      return { soLineId: so.id, itemCode: so.item.code, itemName: so.item.name, style: l.style.code, color: l.color, sizeGroup: l.style.sizeGroup?.name ?? null, info, sizes }
    })

  return {
    mo: { id: mo.id, moNumber: mo.moNumber },
    so: { id: mo.so.id, soNumber: mo.so.soNumber, poRef: mo.so.customerPORef },
    customer: { id: c.id, name: c.name },
    // Month and year of manufacture: when it was packed into finished goods.
    mfd: lastReceipt?.receiptDate ?? new Date(),
    profile,
    lines,
  }
}

/** The customer's details and each line's, saved together. */
export async function saveBuyerLabels(moId: string, data: z.infer<typeof saveSchema>) {
  const mo = await orderOf(moId)
  const mine = new Set(mo.lines.map((l) => l.soLine?.id).filter(Boolean))
  for (const l of data.lines) if (!mine.has(l.soLineId)) throw new AppError(`That line is not on ${mo.moNumber}.`, 400, 'WRONG_LINE')
  await prisma.$transaction(async (tx) => {
    await tx.customer.update({ where: { id: mo.so.customer.id }, data: { labelProfile: data.profile as unknown as Prisma.InputJsonValue } })
    for (const l of data.lines) {
      await tx.salesOrderLine.update({ where: { id: l.soLineId }, data: { labelInfo: l.info as unknown as Prisma.InputJsonValue } })
    }
  })
  return { mo, customer: mo.so.customer.name }
}
