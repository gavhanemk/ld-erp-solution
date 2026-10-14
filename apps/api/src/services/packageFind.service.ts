import { prisma, type Prisma } from '@ld-erp/database'
import { z } from 'zod'
import { normaliseCode, round3 } from './package.service'

/*
 * Finding a sticker without knowing its number.
 *
 * People remember what came in and where it went, not PK-000123: "the poplin
 * from Bhiwandi", "challan BPF/DC/2210", "lot 2210", "what went to MO-0001",
 * "rack B-3". One search reads all of it — typed as one line under the scan
 * box, or picked detail by detail from dropdowns.
 */

export const findSchema = z.object({
  q: z.string().trim().max(80).optional(),
  itemId: z.string().optional(),
  warehouseId: z.string().optional(),
  supplierId: z.string().optional(),
  poId: z.string().optional(),
  /** A goods receipt — ours from a supplier, or a customer's. */
  grnId: z.string().optional(),
  lot: z.string().max(60).optional(),
  rack: z.string().max(40).optional(),
  soId: z.string().optional(),
  moId: z.string().optional(),
  /** Several items at once: what a requisition still asks for. */
  itemIds: z.string().max(4000).optional(),
  /** IN_STOCK for something to scan; ALL to trace what has gone out too. */
  status: z.enum(['IN_STOCK', 'ALL']).default('ALL'),
  limit: z.coerce.number().int().min(1).max(200).default(20),
})
export type FindQuery = z.infer<typeof findSchema>

const ci = 'insensitive' as const

/** The receipts a word or a pick points at: our GRNs and customers' receipts. */
async function receiptIds(where: { q?: string; supplierId?: string; poId?: string; grnId?: string; soId?: string }) {
  const { q, supplierId, poId, grnId, soId } = where
  const [grns, customerGrns] = await Promise.all([
    soId
      ? Promise.resolve([])
      : prisma.gRN.findMany({
          where: {
            ...(grnId ? { id: grnId } : {}),
            ...(poId ? { poId } : {}),
            ...(supplierId ? { po: { supplierId } } : {}),
            ...(q
              ? {
                  OR: [
                    { grnNumber: { contains: q, mode: ci } },
                    { challanNo: { contains: q, mode: ci } },
                    { supplierBillNo: { contains: q, mode: ci } },
                    { supplierInvoiceNo: { contains: q, mode: ci } },
                    { po: { poNumber: { contains: q, mode: ci } } },
                    { po: { supplier: { name: { contains: q, mode: ci } } } },
                  ],
                }
              : {}),
          },
          select: { id: true },
          take: 500,
        }),
    supplierId || poId
      ? Promise.resolve([])
      : prisma.customerGRN.findMany({
          where: {
            ...(grnId ? { id: grnId } : {}),
            ...(soId ? { soId } : {}),
            ...(q
              ? {
                  OR: [
                    { grnNumber: { contains: q, mode: ci } },
                    { challanNumber: { contains: q, mode: ci } },
                    { customer: { name: { contains: q, mode: ci } } },
                    { so: { soNumber: { contains: q, mode: ci } } },
                  ],
                }
              : {}),
          },
          select: { id: true },
          take: 500,
        }),
  ])
  return [...grns, ...customerGrns].map((r) => r.id)
}

/** The packages issued against requisitions of an order, an MO, or matching a word. */
async function issuedTo(where: { q?: string; soId?: string; moId?: string }) {
  const { q, soId, moId } = where
  const mrs = await prisma.materialRequisition.findMany({
    where: {
      ...(moId ? { moId } : {}),
      ...(soId ? { OR: [{ soId }, { mo: { soId } }] } : {}),
      ...(q
        ? {
            OR: [
              { mrNumber: { contains: q, mode: ci } },
              { mo: { moNumber: { contains: q, mode: ci } } },
              { so: { soNumber: { contains: q, mode: ci } } },
              { mo: { so: { soNumber: { contains: q, mode: ci } } } },
            ],
          }
        : {}),
    },
    select: { id: true },
    take: 500,
  })
  if (!mrs.length) return []
  const moves = await prisma.stockPackageMove.findMany({
    where: { referenceType: 'MATERIAL_REQUISITION', referenceId: { in: mrs.map((m) => m.id) } },
    select: { packageId: true },
    distinct: ['packageId'],
    take: 2000,
  })
  return moves.map((m) => m.packageId)
}

/** The stickers that match: in stock first, the newest first. */
export async function findPackages(f: FindQuery) {
  const q = f.q?.trim() || undefined
  const and: Prisma.StockPackageWhereInput[] = []
  if (f.status === 'IN_STOCK') and.push({ status: 'IN_STOCK' })
  if (f.itemId) and.push({ itemId: f.itemId })
  if (f.itemIds) and.push({ itemId: { in: f.itemIds.split(',').filter(Boolean).slice(0, 200) } })
  if (f.warehouseId) and.push({ warehouseId: f.warehouseId })
  if (f.lot) and.push({ lotNo: { equals: f.lot, mode: ci } })
  if (f.rack) and.push({ rack: { equals: f.rack, mode: ci } })
  if (f.supplierId || f.poId || f.grnId) {
    const ids = await receiptIds({ supplierId: f.supplierId, poId: f.poId, grnId: f.grnId })
    and.push({ sourceId: { in: ids } })
  }
  if (f.soId || f.moId) {
    const [went, came] = await Promise.all([issuedTo({ soId: f.soId, moId: f.moId }), f.soId && !f.moId ? receiptIds({ soId: f.soId }) : Promise.resolve([])])
    and.push({ OR: [{ id: { in: went } }, ...(came.length ? [{ sourceId: { in: came } }] : [])] })
  }
  if (q) {
    const code = normaliseCode(q).replace(/^PK-0*/, '')
    const [receipts, went] = await Promise.all([receiptIds({ q }), issuedTo({ q })])
    and.push({
      OR: [
        ...(code ? [{ code: { contains: code, mode: ci } }] : []),
        { item: { name: { contains: q, mode: ci } } },
        { item: { code: { contains: q, mode: ci } } },
        { lotNo: { contains: q, mode: ci } },
        { rack: { contains: q, mode: ci } },
        { sourceRef: { contains: q, mode: ci } },
        ...(receipts.length ? [{ sourceId: { in: receipts } }] : []),
        ...(went.length ? [{ id: { in: went } }] : []),
      ],
    })
  }
  const where: Prisma.StockPackageWhereInput = and.length ? { AND: and } : {}
  const [inStock, total] = await Promise.all([
    prisma.stockPackage.count({ where: { AND: [...and, { status: 'IN_STOCK' }] } }),
    prisma.stockPackage.count({ where }),
  ])
  // In stock first: what can be picked up is what is usually looked for.
  const rows = [
    ...(await prisma.stockPackage.findMany({ where: { AND: [...and, { status: 'IN_STOCK' }] }, orderBy: [{ createdAt: 'desc' }, { code: 'asc' }], take: f.limit, select: SELECT })),
  ]
  if (rows.length < f.limit && f.status === 'ALL') {
    rows.push(...(await prisma.stockPackage.findMany({ where: { AND: [...and, { status: { not: 'IN_STOCK' } }] }, orderBy: [{ updatedAt: 'desc' }], take: f.limit - rows.length, select: SELECT })))
  }
  return { rows: await describe(rows), total, inStock }
}

const SELECT = {
  id: true,
  code: true,
  status: true,
  qty: true,
  packType: true,
  lotNo: true,
  rack: true,
  sourceType: true,
  sourceId: true,
  sourceRef: true,
  createdAt: true,
  item: { select: { id: true, code: true, name: true, uom: { select: { symbol: true } } } },
  warehouse: { select: { id: true, name: true } },
  ownerCustomer: { select: { name: true } },
} satisfies Prisma.StockPackageSelect
type Row = Prisma.StockPackageGetPayload<{ select: typeof SELECT }>

/** Each sticker with where it came from and where it went, in words. */
async function describe(rows: Row[]) {
  const sourceIds = [...new Set(rows.map((r) => r.sourceId).filter((x): x is string => !!x))]
  const [grns, customerGrns, moves] = await Promise.all([
    sourceIds.length
      ? prisma.gRN.findMany({ where: { id: { in: sourceIds } }, select: { id: true, grnNumber: true, grnDate: true, challanNo: true, po: { select: { poNumber: true, supplier: { select: { name: true } } } } } })
      : Promise.resolve([]),
    sourceIds.length
      ? prisma.customerGRN.findMany({ where: { id: { in: sourceIds } }, select: { id: true, grnNumber: true, receiptDate: true, challanNumber: true, customer: { select: { name: true } }, so: { select: { soNumber: true } } } })
      : Promise.resolve([]),
    rows.length
      ? prisma.stockPackageMove.findMany({
          where: { packageId: { in: rows.map((r) => r.id) }, referenceType: 'MATERIAL_REQUISITION' },
          select: { packageId: true, referenceId: true, referenceNumber: true },
        })
      : Promise.resolve([]),
  ])
  const mrIds = [...new Set(moves.map((m) => m.referenceId).filter((x): x is string => !!x))]
  const mrs = mrIds.length
    ? await prisma.materialRequisition.findMany({ where: { id: { in: mrIds } }, select: { id: true, mrNumber: true, department: { select: { name: true } }, mo: { select: { moNumber: true } }, so: { select: { soNumber: true } } } })
    : []
  const grnOf = new Map(grns.map((g) => [g.id, g]))
  const cgrnOf = new Map(customerGrns.map((g) => [g.id, g]))
  const mrOf = new Map(mrs.map((m) => [m.id, m]))
  return rows.map((r) => {
    const g = r.sourceId ? grnOf.get(r.sourceId) : undefined
    const c = r.sourceId ? cgrnOf.get(r.sourceId) : undefined
    const went = [...new Set(moves.filter((m) => m.packageId === r.id).map((m) => m.referenceId))]
      .map((id) => (id ? mrOf.get(id) : undefined))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({ mr: m.mrNumber, department: m.department?.name ?? null, mo: m.mo?.moNumber ?? null, so: m.so?.soNumber ?? null }))
    return {
      id: r.id,
      code: r.code,
      status: r.status,
      qty: round3(Number(r.qty)),
      unit: r.item.uom?.symbol ?? '',
      packType: r.packType,
      item: { id: r.item.id, code: r.item.code, name: r.item.name },
      store: r.warehouse.name,
      rack: r.rack,
      lotNo: r.lotNo,
      owner: r.ownerCustomer?.name ?? null,
      came: g
        ? { ref: g.grnNumber, date: g.grnDate, challan: g.challanNo, po: g.po?.poNumber ?? null, from: g.po?.supplier?.name ?? null }
        : c
          ? { ref: c.grnNumber, date: c.receiptDate, challan: c.challanNumber, po: c.so?.soNumber ?? null, from: c.customer.name }
          : { ref: r.sourceRef, date: r.createdAt, challan: null, po: null, from: null },
      went,
    }
  })
}

/**
 * What the dropdowns offer: only what some sticker carries, so no choice
 * leads to an empty list. Suppliers, orders and receipts come with what ties
 * them together, so picking one narrows the next.
 */
export async function findOptions() {
  const packages = await prisma.stockPackage.findMany({
    select: { itemId: true, warehouseId: true, lotNo: true, rack: true, sourceId: true },
    take: 50_000,
  })
  const sourceIds = [...new Set(packages.map((p) => p.sourceId).filter((x): x is string => !!x))]
  const itemIds = [...new Set(packages.map((p) => p.itemId))]
  const storeIds = [...new Set(packages.map((p) => p.warehouseId))]
  const [items, stores, grns, customerGrns, moves] = await Promise.all([
    prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.warehouse.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.gRN.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, grnNumber: true, grnDate: true, challanNo: true, poId: true, po: { select: { poNumber: true, supplierId: true, supplier: { select: { name: true } } } } },
      orderBy: { grnDate: 'desc' },
    }),
    prisma.customerGRN.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, grnNumber: true, receiptDate: true, challanNumber: true, soId: true, customer: { select: { name: true } } },
      orderBy: { receiptDate: 'desc' },
    }),
    prisma.stockPackageMove.findMany({ where: { referenceType: 'MATERIAL_REQUISITION' }, select: { referenceId: true }, distinct: ['referenceId'], take: 5000 }),
  ])
  const mrs = await prisma.materialRequisition.findMany({
    where: { id: { in: moves.map((m) => m.referenceId).filter((x): x is string => !!x) } },
    select: { soId: true, so: { select: { id: true, soNumber: true, customer: { select: { name: true } } } }, mo: { select: { id: true, moNumber: true, soId: true, so: { select: { id: true, soNumber: true, customer: { select: { name: true } } } } } } },
  })
  const sos = new Map<string, { id: string; soNumber: string; customer: string }>()
  const mos = new Map<string, { id: string; moNumber: string; soId: string | null }>()
  for (const m of mrs) {
    const so = m.so ?? m.mo?.so
    if (so) sos.set(so.id, { id: so.id, soNumber: so.soNumber, customer: so.customer.name })
    if (m.mo) mos.set(m.mo.id, { id: m.mo.id, moNumber: m.mo.moNumber, soId: m.mo.soId })
  }
  const suppliers = new Map<string, { id: string; name: string }>()
  const pos = new Map<string, { id: string; poNumber: string; supplierId: string }>()
  for (const g of grns) {
    if (g.po?.supplierId) suppliers.set(g.po.supplierId, { id: g.po.supplierId, name: g.po.supplier?.name ?? '' })
    if (g.poId && g.po) pos.set(g.poId, { id: g.poId, poNumber: g.po.poNumber, supplierId: g.po.supplierId })
  }
  const byText = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })
  return {
    items: items.map((i) => ({ id: i.id, code: i.code, name: i.name })),
    stores,
    suppliers: [...suppliers.values()].sort((a, b) => byText(a.name, b.name)),
    pos: [...pos.values()].sort((a, b) => byText(b.poNumber, a.poNumber)),
    receipts: [
      ...grns.map((g) => ({ id: g.id, number: g.grnNumber, challan: g.challanNo, date: g.grnDate, from: g.po?.supplier?.name ?? '', poId: g.poId, supplierId: g.po?.supplierId ?? null, soId: null as string | null })),
      ...customerGrns.map((c) => ({ id: c.id, number: c.grnNumber, challan: c.challanNumber, date: c.receiptDate, from: c.customer.name, poId: null as string | null, supplierId: null as string | null, soId: c.soId })),
    ],
    lots: [...new Set(packages.map((p) => p.lotNo).filter((x): x is string => !!x))].sort(byText),
    racks: [...new Set(packages.map((p) => p.rack).filter((x): x is string => !!x))].sort(byText),
    sos: [...sos.values()].sort((a, b) => byText(b.soNumber, a.soNumber)),
    mos: [...mos.values()].sort((a, b) => byText(b.moNumber, a.moNumber)),
  }
}
