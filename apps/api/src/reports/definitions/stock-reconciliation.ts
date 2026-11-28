import { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import { round2 } from './shared'
import { rupees, warehouseFilter } from './inventory-shared'
import { inventoryValue } from '../../services/accounts/finalAccounts.service'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** Today in India, as YYYY-MM-DD. */
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)

/**
 * Where the stock records disagree with the stock ledger.
 *
 * The ledger is the one record of what is in the stores. Everything else
 * that counts stock is a part of it, never extra: a roll's sticker, a
 * garment's tag, the pieces sealed in a carton, a hold for a requisition.
 * When one of them claims more than the ledger holds — or the ledger itself
 * goes below nothing, or keeps value on nothing — it is listed here, with what
 * each side says. And the stock's value is set against the closing stock the
 * books carry, every difference explained.
 *
 * An empty report is the answer it exists to give.
 */
export const stockReconciliation: ReportDefinition = {
  id: 'stock-reconciliation',
  module: 'inventory',
  title: 'Stock Reconciliation',
  description:
    'Where stock records disagree with the stock ledger — stickers, garment tags, sealed cartons or holds claiming more than it holds, balances below nothing, value on nothing — and the stock value against the books.',
  filters: [warehouseFilter],
  columns: [
    {
      key: 'check',
      label: 'Finding',
      type: 'badge',
      width: 16,
      badges: {
        NEGATIVE: 'Below zero',
        VALUE_ON_NOTHING: 'Value on nothing',
        STICKERS: 'Stickers over',
        TAGS: 'Tags over',
        CARTONS: 'Cartons over',
        HOLDS: 'Holds over',
      },
      badgeTones: { NEGATIVE: 'bad', VALUE_ON_NOTHING: 'bad', STICKERS: 'warn', TAGS: 'warn', CARTONS: 'warn', HOLDS: 'warn' },
    },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'store', label: 'Store', type: 'text', width: 18 },
    { key: 'whose', label: 'Whose', type: 'text', width: 16 },
    { key: 'share', label: 'Share', type: 'text', width: 16 },
    { key: 'size', label: 'Size', type: 'text', width: 8 },
    { key: 'grade', label: 'Grade', type: 'text', width: 8 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'ledger', label: 'Ledger Holds', type: 'qty', unitKey: 'uom', total: 'none' },
    { key: 'claimed', label: 'Record Claims', type: 'qty', unitKey: 'uom', total: 'none' },
    { key: 'difference', label: 'Difference', type: 'qty', unitKey: 'uom', total: 'none' },
    { key: 'value', label: 'Value', type: 'money', total: 'sum' },
    { key: 'action', label: 'What to do', type: 'text', width: 44 },
  ],
  summary: {
    title: 'What disagrees with the ledger',
    columns: ['check', 'item', 'store', 'ledger', 'claimed', 'difference'],
    by: 'difference',
    limit: 20,
  },

  async run({ tx, params, rowCap }) {
    const store = (params.warehouseId as string | undefined) || null
    const inStore = (col: string) => (store ? Prisma.sql`AND ${Prisma.raw(col)} = ${store}` : Prisma.empty)

    // Share by share (multi-brand phase 5): a brand's earmark and central stock each answer for themselves.
    type Found = { itemId: string; warehouseId: string; ownership: string; owner: string | null; sizeId: string | null; grade: string | null; brandId?: string | null; ledger: number; claimed: number; value?: number }
    const label = await tx.$queryRaw<Array<{ id: string; code: string; name: string; uom: string | null }>>`
      SELECT i.id, i.code, i.name, u.symbol AS uom FROM ld_erp.items i LEFT JOIN ld_erp.uom u ON u.id = i."uomId"`
    const itemOf = new Map(label.map((i) => [i.id, i]))
    const stores = new Map((await tx.warehouse.findMany({ select: { id: true, name: true } })).map((w) => [w.id, w.name]))
    const customers = new Map((await tx.customer.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name]))
    const sizes = new Map((await tx.size.findMany({ select: { id: true, code: true } })).map((z) => [z.id, z.code]))
    const brands = new Map((await tx.brand.findMany({ select: { id: true, name: true } })).map((b) => [b.id, b.name]))

    // Balances below nothing, and value left on balances of nothing.
    const balances = await tx.$queryRaw<Array<Found & { qty: number }>>`
      SELECT s."itemId", s."warehouseId", s.ownership::text AS ownership, s."ownerCustomerId" AS owner, s."sizeId", s.grade, s."brandId",
             SUM(s."inQty" - s."outQty")::float8 AS qty,
             SUM((s."inQty" - s."outQty") * COALESCE(s."unitRate", 0))::float8 AS value
      FROM ld_erp.stock_ledger s
      WHERE TRUE ${inStore('s."warehouseId"')}
      GROUP BY s."itemId", s."warehouseId", s.ownership, s."ownerCustomerId", s."sizeId", s.grade, s."brandId"
      HAVING SUM(s."inQty" - s."outQty") < -0.0005
          OR (ABS(SUM(s."inQty" - s."outQty")) <= 0.0005 AND ABS(SUM((s."inQty" - s."outQty") * COALESCE(s."unitRate", 0))) >= 0.01)`

    // Stickers on the rack, per item, store, owner and share (all grades: a roll's grade can change in place).
    const stickers = await tx.$queryRaw<Found[]>`
      WITH p AS (
        SELECT "itemId", "warehouseId", ownership::text AS ownership, "ownerCustomerId" AS owner, "brandId", SUM(qty)::float8 AS claimed
        FROM ld_erp.stock_packages WHERE status::text = 'IN_STOCK' ${inStore('"warehouseId"')}
        GROUP BY 1, 2, 3, 4, 5),
      l AS (
        SELECT "itemId", "warehouseId", ownership::text AS ownership, "ownerCustomerId" AS owner, "brandId", SUM("inQty" - "outQty")::float8 AS ledger
        FROM ld_erp.stock_ledger GROUP BY 1, 2, 3, 4, 5)
      SELECT p."itemId", p."warehouseId", p.ownership, p.owner, NULL::text AS "sizeId", NULL::text AS grade, p."brandId", COALESCE(l.ledger, 0) AS ledger, p.claimed
      FROM p LEFT JOIN l ON l."itemId" = p."itemId" AND l."warehouseId" = p."warehouseId" AND l.ownership = p.ownership AND l.owner IS NOT DISTINCT FROM p.owner
        AND l."brandId" IS NOT DISTINCT FROM p."brandId"
      WHERE p.claimed > COALESCE(l.ledger, 0) + 0.0005`

    // Garment tags still in the store, per item, store, size, grade and owner.
    const tags = await tx.$queryRaw<Found[]>`
      WITH g AS (
        SELECT "itemId", "warehouseId", ownership::text AS ownership, "ownerCustomerId" AS owner, "sizeId", grade, "brandId", COUNT(*)::float8 AS claimed
        FROM ld_erp.garments WHERE status::text IN ('IN_STOCK', 'PACKED') ${inStore('"warehouseId"')}
        GROUP BY 1, 2, 3, 4, 5, 6, 7),
      l AS (
        SELECT "itemId", "warehouseId", ownership::text AS ownership, "ownerCustomerId" AS owner, "sizeId", grade, "brandId", SUM("inQty" - "outQty")::float8 AS ledger
        FROM ld_erp.stock_ledger GROUP BY 1, 2, 3, 4, 5, 6, 7)
      SELECT g."itemId", g."warehouseId", g.ownership, g.owner, g."sizeId", g.grade, g."brandId", COALESCE(l.ledger, 0) AS ledger, g.claimed
      FROM g LEFT JOIN l ON l."itemId" = g."itemId" AND l."warehouseId" = g."warehouseId" AND l.ownership = g.ownership
        AND l.owner IS NOT DISTINCT FROM g.owner AND l."sizeId" IS NOT DISTINCT FROM g."sizeId" AND l.grade = g.grade
        AND l."brandId" IS NOT DISTINCT FROM g."brandId"
      WHERE g.claimed > COALESCE(l.ledger, 0) + 0.0005`

    // Pieces sealed in cartons still in the store.
    const cartons = await tx.$queryRaw<Found[]>`
      WITH c AS (
        SELECT cl."itemId", c."warehouseId", cl."sizeId", cl.grade, c."brandId", SUM(cl.qty)::float8 AS claimed
        FROM ld_erp.fg_carton_lines cl JOIN ld_erp.fg_cartons c ON c.id = cl."cartonId"
        WHERE c.status::text = 'PACKED' ${inStore('c."warehouseId"')}
        GROUP BY 1, 2, 3, 4, 5),
      l AS (
        SELECT "itemId", "warehouseId", "sizeId", grade, "brandId", SUM("inQty" - "outQty")::float8 AS ledger
        FROM ld_erp.stock_ledger WHERE ownership::text = 'OWNED' GROUP BY 1, 2, 3, 4, 5)
      SELECT c."itemId", c."warehouseId", 'OWNED' AS ownership, NULL::text AS owner, c."sizeId", c.grade, c."brandId", COALESCE(l.ledger, 0) AS ledger, c.claimed
      FROM c LEFT JOIN l ON l."itemId" = c."itemId" AND l."warehouseId" = c."warehouseId" AND l."sizeId" IS NOT DISTINCT FROM c."sizeId" AND l.grade = c.grade
        AND l."brandId" IS NOT DISTINCT FROM c."brandId"
      WHERE c.claimed > COALESCE(l.ledger, 0) + 0.0005`

    // Holds for requisitions, against our good stock in the store.
    const holds = await tx.$queryRaw<Found[]>`
      WITH h AS (
        SELECT "itemId", "warehouseId", "brandId", SUM(qty)::float8 AS claimed
        FROM ld_erp.stock_reservations WHERE status::text = 'ACTIVE' ${inStore('"warehouseId"')}
        GROUP BY 1, 2, 3),
      l AS (
        SELECT "itemId", "warehouseId", "brandId", SUM("inQty" - "outQty")::float8 AS ledger
        FROM ld_erp.stock_ledger WHERE ownership::text = 'OWNED' AND grade = 'A' AND "sizeId" IS NULL GROUP BY 1, 2, 3)
      SELECT h."itemId", h."warehouseId", 'OWNED' AS ownership, NULL::text AS owner, NULL::text AS "sizeId", 'A' AS grade, h."brandId", COALESCE(l.ledger, 0) AS ledger, h.claimed
      FROM h LEFT JOIN l ON l."itemId" = h."itemId" AND l."warehouseId" = h."warehouseId" AND l."brandId" IS NOT DISTINCT FROM h."brandId"
      WHERE h.claimed > COALESCE(l.ledger, 0) + 0.0005`

    const ACTION: Record<string, string> = {
      NEGATIVE: 'Find the movement that took more than was there (Item Stock Ledger), and correct it with a count.',
      VALUE_ON_NOTHING: 'Value left with no stock: a rate went in wrong. Look at its last movements in the Item Stock Ledger.',
      STICKERS: 'Stickers claim rolls the ledger no longer holds: finish the labels window for the last issue or return, or void the stickers of rolls that are gone.',
      TAGS: 'Garment tags claim pieces the ledger no longer holds: void or scrap the tags of pieces that left.',
      CARTONS: 'Cartons claim pieces the ledger no longer holds: open the cartons and pack again what is there.',
      HOLDS: 'Holds promise more than the store holds: release the hold, or let the requisition take what is there.',
    }
    const shape = (check: string, f: Found) => {
      const item = itemOf.get(f.itemId)
      const ledger = r3(Number(f.ledger))
      const claimed = r3(Number(f.claimed))
      return {
        check,
        itemCode: item?.code ?? '',
        item: item?.name ?? '',
        store: stores.get(f.warehouseId) ?? '',
        whose: f.ownership === 'OWNED' ? 'Ours' : (customers.get(f.owner ?? '') ?? 'Customer'),
        share: f.brandId ? (brands.get(f.brandId) ?? 'A brand') : f.brandId === null ? 'Central' : '',
        size: f.sizeId ? (sizes.get(f.sizeId) ?? '') : '',
        grade: f.grade ?? '',
        uom: item?.uom ?? '',
        ledger,
        claimed,
        difference: r3(claimed - ledger),
        value: f.value !== undefined ? round2(Number(f.value)) : null,
        action: ACTION[check],
      }
    }
    const rows = [
      ...balances.map((b) => (Number(b.qty) < -0.0005 ? shape('NEGATIVE', { ...b, ledger: Number(b.qty), claimed: 0 }) : shape('VALUE_ON_NOTHING', { ...b, ledger: 0, claimed: 0 }))),
      ...stickers.map((f) => shape('STICKERS', f)),
      ...tags.map((f) => shape('TAGS', f)),
      ...cartons.map((f) => shape('CARTONS', f)),
      ...holds.map((f) => shape('HOLDS', f)),
    ]

    // The stock's value against the books' closing stock, every difference named.
    const [{ all, assets }] = await tx.$queryRaw<Array<{ all: number; assets: number }>>`
      SELECT COALESCE(SUM((l."inQty" - l."outQty") * COALESCE(l."unitRate", 0)), 0)::float8 AS "all",
             COALESCE(SUM((l."inQty" - l."outQty") * COALESCE(l."unitRate", 0)) FILTER (WHERE i.type::text = 'FIXED_ASSET'), 0)::float8 AS assets
      FROM ld_erp.stock_ledger l JOIN ld_erp.items i ON i.id = l."itemId"
      WHERE l.ownership::text = 'OWNED'`
    const books = await inventoryValue(tx, today())
    const stockValue = round2(all)
    const assetValue = round2(assets)
    const unexplained = round2(stockValue - assetValue - books)

    const count = (c: string) => rows.filter((r) => r.check === c).length
    const panels: Panel[] = (
      [
      {
        title: 'Findings, by kind',
        question: 'composition' as const,
        format: 'integer' as const,
        points: [
          { label: 'Below zero', value: count('NEGATIVE'), tone: 'bad' as const },
          { label: 'Value on nothing', value: count('VALUE_ON_NOTHING'), tone: 'bad' as const },
          { label: 'Stickers over', value: count('STICKERS'), tone: 'warn' as const },
          { label: 'Tags over', value: count('TAGS'), tone: 'warn' as const },
          { label: 'Cartons over', value: count('CARTONS'), tone: 'warn' as const },
          { label: 'Holds over', value: count('HOLDS'), tone: 'warn' as const },
        ].filter((p) => p.value > 0),
      },
      ] as Panel[]
    ).filter((p) => p.points.length > 0)

    return {
      rows: rows.slice(0, rowCap),
      totalRows: rows.length > rowCap ? rows.length : undefined,
      analysis: {
        headline: rows.length
          ? `${rows.length} ${rows.length === 1 ? 'record disagrees' : 'records disagree'} with the stock ledger${store ? ` in ${stores.get(store) ?? 'this store'}` : ''}.`
          : `Every stock record agrees with the stock ledger${store ? ` in ${stores.get(store) ?? 'this store'}` : ''}.`,
        kpis: [
          { label: 'Findings', value: rows.length, format: 'integer', basis: 'records that disagree with the ledger', tone: rows.length ? 'warn' : 'good' },
          { label: 'Stock value', value: stockValue, format: 'money', basis: 'our own stock in every store, fixed assets included' },
          { label: 'Books’ closing stock', value: books, format: 'money', basis: 'the same, fixed assets left out (they are in their own ledger)' },
          { label: 'Not explained', value: unexplained, format: 'money', basis: `stock value − fixed assets ${rupees(assetValue)} − books`, tone: Math.abs(unexplained) >= 1 ? 'bad' : 'good' },
        ],
        panels,
        insights: [
          ...(rows.length ? [] : ['Stickers, garment tags, sealed cartons and holds each claim no more than the ledger holds, and no balance is below nothing.']),
          Math.abs(unexplained) < 1
            ? `The stock value agrees with the books' closing stock once fixed assets (${rupees(assetValue)}) are set aside.`
            : `The stock value and the books' closing stock differ by ${rupees(unexplained)} beyond fixed assets: a value set by hand in Accounts, or a movement after the books were read.`,
        ],
        caveats: [
          'Stickers are checked per item, store and owner across grades, because a roll held as rejected keeps its sticker.',
          'A sticker can show as over just after an issue or return typed in by hand, until its labels window says which rolls went.',
          'Customer material is checked like our own, and carries no value.',
          'The value comparison is for today. A closing stock set by hand in Accounts is not compared here.',
        ],
      },
    }
  },
}
