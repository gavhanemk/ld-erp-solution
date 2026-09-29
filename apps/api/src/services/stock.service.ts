import type { Prisma, StockOwnership, TransactionType } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * The only place in the system that is allowed to write a stock movement.
 *
 * Everything about stock going wrong in a factory comes from the same two
 * habits: somebody typing a corrected quantity straight into a balance, and two
 * different screens each keeping their own idea of what is on hand. So there is
 * one writer, and it enforces the four rules from docs/04-business-rules.md:
 *
 *   1. Stock is never negative. An issue of 120 against 100 on hand is refused,
 *      and the refusal says what is actually there.
 *   2. Stock only moves through a document. Every row carries the document type
 *      and id that caused it; there is no way to call this without one.
 *   3. Every movement is a row. The balance is the sum of the rows. Nothing
 *      keeps a running total that could drift away from its own history.
 *   4. Stock lives in a warehouse. There is no such thing as a balance without
 *      one.
 *
 * Valuation is weighted average, chosen once for the whole system. It is what a
 * Tally-trained accountant expects, it survives a part-received order, and it
 * does not need batches to be tracked before the mill is ready to track them.
 */

/** Quantities are stored to three decimals; fabric is issued in metres. */
const round3 = (n: number) => Math.round(n * 1000) / 1000
/** Money to two. */
const round2 = (n: number) => Math.round(n * 100) / 100

/** Which balance a movement belongs to. Our own cloth and a customer's never mix. */
export interface StockKey {
  itemId: string
  warehouseId: string
  ownership?: StockOwnership
  /** Required when ownership is CUSTOMER_OWNED — whose cloth this is. */
  ownerCustomerId?: string | null
}

export interface Movement extends StockKey {
  transactionType: TransactionType
  direction: 'IN' | 'OUT'
  qty: number
  /**
   * What one unit came in at. Required on the way in, ignored on the way out —
   * stock leaves at the running average, never at a rate somebody types, or the
   * value left behind would not match the quantity left behind.
   */
  unitRate?: number
  /** The document that caused this. Both halves are required; see rule 2. */
  referenceType: string
  referenceId: string
  batchNumber?: string | null
  transactionDate?: Date
  notes?: string | null
}

export interface Balance {
  /** Units on hand. */
  qty: number
  /** What those units are carried at, in rupees. */
  value: number
  /** value ÷ qty, or 0 when nothing is on hand. */
  avgRate: number
}

/**
 * Stops two people moving the same item in the same warehouse at the same
 * moment.
 *
 * Without this, two issues of 60 against 100 on hand both read "100 available",
 * both pass the check, and the balance lands at −20. The lock is held to the
 * end of the caller's transaction and released with it, so a crash cannot leave
 * an item stuck.
 */
async function lockBalance(tx: Prisma.TransactionClient, key: StockKey): Promise<void> {
  const token = [
    key.itemId,
    key.warehouseId,
    key.ownership ?? 'OWNED',
    key.ownerCustomerId ?? '',
  ].join('|')

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${token})::bigint)`
}

/**
 * What is on hand right now, and what it is carried at.
 *
 * Both numbers are read back out of the movements rather than kept anywhere —
 * quantity is what came in minus what went out, and value is the same sum
 * priced at each row's own rate. Because outward rows are written at the
 * running average (see `recordMovement`), the two stay in step: an item at zero
 * quantity is also at zero value, which is the property that makes the stock
 * figure and the balance sheet agree.
 */
export async function balanceOf(
  tx: Prisma.TransactionClient,
  key: StockKey,
): Promise<Balance> {
  const rows = await tx.$queryRaw<Array<{ qty: number | null; value: number | null }>>`
    SELECT
      COALESCE(SUM("inQty" - "outQty"), 0)::float8                        AS qty,
      COALESCE(SUM(("inQty" - "outQty") * COALESCE("unitRate", 0)), 0)::float8 AS value
    FROM ld_erp.stock_ledger
    WHERE "itemId" = ${key.itemId}
      AND "warehouseId" = ${key.warehouseId}
      AND "ownership" = ${key.ownership ?? 'OWNED'}::ld_erp."StockOwnership"
      AND "ownerCustomerId" IS NOT DISTINCT FROM ${key.ownerCustomerId ?? null}::text
  `

  const qty = round3(rows[0]?.qty ?? 0)
  const value = round2(rows[0]?.value ?? 0)

  return { qty, value, avgRate: qty > 0 ? round2(value / qty) : 0 }
}

/**
 * The balance, read while holding the item's lock.
 *
 * For a document that decides what to write from what is there now: a count
 * works out its correction as counted minus book. Read unlocked, an issue
 * landing between that read and the correction would be undone by it, or
 * doubled. The lock is the same one `recordMovement` takes, held to the end
 * of the transaction, so taking it twice is harmless.
 */
export async function lockedBalanceOf(
  tx: Prisma.TransactionClient,
  key: StockKey,
): Promise<Balance> {
  await lockBalance(tx, key)
  return balanceOf(tx, key)
}

/**
 * Writes one movement.
 *
 * Must be called inside a transaction that also creates the document causing
 * it, so a receipt and the stock it brought in either both exist or neither
 * does. Returns the new balance so the caller can report it back.
 */
export async function recordMovement(
  tx: Prisma.TransactionClient,
  m: Movement,
): Promise<{ balance: Balance; unitRate: number }> {
  if (!(m.qty > 0)) {
    throw new AppError('A stock movement must be for more than zero', 400, 'INVALID_QTY')
  }
  if (!m.referenceType || !m.referenceId) {
    throw new AppError(
      'Stock cannot move without a document behind it',
      500,
      'STOCK_WITHOUT_DOCUMENT',
    )
  }
  if ((m.ownership ?? 'OWNED') === 'CUSTOMER_OWNED' && !m.ownerCustomerId) {
    throw new AppError(
      'Customer-owned stock has to say whose it is',
      400,
      'NO_STOCK_OWNER',
    )
  }

  await lockBalance(tx, m)

  const before = await balanceOf(tx, m)
  const qty = round3(m.qty)

  let unitRate: number

  if (m.direction === 'IN') {
    if (m.unitRate === undefined || m.unitRate === null) {
      throw new AppError(
        'Stock coming in needs a rate, or it cannot be valued',
        400,
        'NO_RATE',
      )
    }
    if (m.unitRate < 0) {
      throw new AppError('A rate cannot be negative', 400, 'NEGATIVE_RATE')
    }
    unitRate = round2(m.unitRate)
  } else {
    if (qty > before.qty) {
      // Naming the shortfall is the whole point. "Insufficient stock" sends
      // somebody to go and count; this tells them what the book says.
      const item = await tx.item.findUnique({
        where: { id: m.itemId },
        select: { name: true, uom: { select: { symbol: true } } },
      })
      const warehouse = await tx.warehouse.findUnique({
        where: { id: m.warehouseId },
        select: { name: true },
      })
      const unit = item?.uom?.symbol ?? ''

      throw new AppError(
        `Only ${before.qty} ${unit} of ${item?.name ?? 'that item'} in ${warehouse?.name ?? 'that warehouse'}. You are trying to take out ${qty}.`.replace(
          /\s+/g,
          ' ',
        ),
        400,
        'INSUFFICIENT_STOCK',
      )
    }
    // Stock leaves at what it is carried at. Any other rate would leave value
    // behind that no quantity accounts for.
    unitRate = before.avgRate
  }

  const closing = round3(m.direction === 'IN' ? before.qty + qty : before.qty - qty)

  await tx.stockLedger.create({
    data: {
      itemId: m.itemId,
      warehouseId: m.warehouseId,
      transactionType: m.transactionType,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      batchNumber: m.batchNumber ?? null,
      ownership: m.ownership ?? 'OWNED',
      ownerCustomerId: m.ownerCustomerId ?? null,
      inQty: m.direction === 'IN' ? qty : 0,
      outQty: m.direction === 'OUT' ? qty : 0,
      // A snapshot for the ledger view to print, so a printed statement does
      // not have to re-add every earlier row. The sum of the rows is still
      // what `balanceOf` trusts.
      closingStock: closing,
      unitRate,
      transactionDate: m.transactionDate ?? new Date(),
      notes: m.notes ?? null,
    },
  })

  return { balance: await balanceOf(tx, m), unitRate }
}

/**
 * Moves stock between two warehouses as one act.
 *
 * The outward leg is written first so the "never negative" check runs against
 * the source before anything lands at the destination, and the inward leg is
 * priced at whatever the outward leg left at — moving cloth across the yard
 * must not change what it is worth.
 */
export async function transferStock(
  tx: Prisma.TransactionClient,
  args: {
    itemId: string
    fromWarehouseId: string
    toWarehouseId: string
    qty: number
    referenceType: string
    referenceId: string
    ownership?: StockOwnership
    ownerCustomerId?: string | null
    transactionDate?: Date
    notes?: string | null
  },
): Promise<void> {
  if (args.fromWarehouseId === args.toWarehouseId) {
    throw new AppError(
      'The two warehouses are the same, so nothing would move',
      400,
      'SAME_WAREHOUSE',
    )
  }

  const out = await recordMovement(tx, {
    itemId: args.itemId,
    warehouseId: args.fromWarehouseId,
    transactionType: 'TRANSFER',
    direction: 'OUT',
    qty: args.qty,
    referenceType: args.referenceType,
    referenceId: args.referenceId,
    ownership: args.ownership,
    ownerCustomerId: args.ownerCustomerId,
    transactionDate: args.transactionDate,
    notes: args.notes,
  })

  await recordMovement(tx, {
    itemId: args.itemId,
    warehouseId: args.toWarehouseId,
    transactionType: 'TRANSFER',
    direction: 'IN',
    qty: args.qty,
    // An empty source values at 0, which would quietly write the stock off on
    // arrival. Falling back to the destination's own average keeps it whole.
    unitRate:
      out.unitRate > 0
        ? out.unitRate
        : (
            await balanceOf(tx, {
              itemId: args.itemId,
              warehouseId: args.toWarehouseId,
              ownership: args.ownership,
              ownerCustomerId: args.ownerCustomerId,
            })
          ).avgRate,
    referenceType: args.referenceType,
    referenceId: args.referenceId,
    ownership: args.ownership,
    ownerCustomerId: args.ownerCustomerId,
    transactionDate: args.transactionDate,
    notes: args.notes,
  })
}

/**
 * Everything on hand, one row per item and warehouse.
 *
 * Grouped in SQL rather than by reading every movement into memory: a mill runs
 * hundreds of movements a day and this screen is opened dozens of times.
 * Balances that have netted to zero are dropped — an item that came and went is
 * history, not stock.
 */
export async function onHand(
  tx: Prisma.TransactionClient,
  filters: {
    itemId?: string
    warehouseId?: string
    categoryId?: string
    ownership?: StockOwnership
    /** Only rows at or below the item's reorder level. */
    lowOnly?: boolean
    search?: string
    /**
     * Every word must appear somewhere in the name or code, in any order.
     *
     * A single substring is enough for a person typing into a search box, who
     * watches the list narrow and stops. It is not enough for the assistant,
     * which asks once with a whole phrase: "cotton poplin white" is not a
     * substring of "Cotton Poplin 40s — White", and one missed match becomes a
     * confident "we don't have any".
     */
    searchWords?: string[]
  } = {},
): Promise<
  Array<{
    itemId: string
    itemCode: string
    itemName: string
    uom: string
    categoryName: string
    reorderLevel: number | null
    warehouseId: string
    warehouseName: string
    ownership: StockOwnership
    ownerCustomerId: string | null
    ownerName: string | null
    qty: number
    value: number
    avgRate: number
    isLow: boolean
    lastMovedAt: Date | null
  }>
> {
  const rows = await tx.$queryRaw<
    Array<{
      itemId: string
      itemCode: string
      itemName: string
      uom: string
      categoryName: string
      reorderLevel: number | null
      warehouseId: string
      warehouseName: string
      ownership: StockOwnership
      ownerCustomerId: string | null
      ownerName: string | null
      qty: number
      value: number
      lastMovedAt: Date | null
    }>
  >`
    SELECT
      i.id                                   AS "itemId",
      i.code                                 AS "itemCode",
      i.name                                 AS "itemName",
      u.symbol                               AS "uom",
      c.name                                 AS "categoryName",
      i."reorderLevel"::float8               AS "reorderLevel",
      w.id                                   AS "warehouseId",
      w.name                                 AS "warehouseName",
      s."ownership"                          AS "ownership",
      s."ownerCustomerId"                    AS "ownerCustomerId",
      cust.name                              AS "ownerName",
      SUM(s."inQty" - s."outQty")::float8    AS "qty",
      SUM((s."inQty" - s."outQty") * COALESCE(s."unitRate", 0))::float8 AS "value",
      MAX(s."transactionDate")               AS "lastMovedAt"
    FROM ld_erp.stock_ledger s
    JOIN ld_erp.items       i    ON i.id = s."itemId"
    JOIN ld_erp.uom         u    ON u.id = i."uomId"
    JOIN ld_erp.item_categories c ON c.id = i."categoryId"
    JOIN ld_erp.warehouses  w    ON w.id = s."warehouseId"
    LEFT JOIN ld_erp.customers cust ON cust.id = s."ownerCustomerId"
    WHERE (${filters.itemId ?? null}::text      IS NULL OR s."itemId" = ${filters.itemId ?? null})
      AND (${filters.warehouseId ?? null}::text IS NULL OR s."warehouseId" = ${filters.warehouseId ?? null})
      AND (${filters.categoryId ?? null}::text  IS NULL OR i."categoryId" = ${filters.categoryId ?? null})
      AND (${filters.ownership ?? null}::text   IS NULL OR s."ownership"::text = ${filters.ownership ?? null})
      AND (${filters.search ?? null}::text      IS NULL
           OR i.name ILIKE '%' || ${filters.search ?? null} || '%'
           OR i.code ILIKE '%' || ${filters.search ?? null} || '%')
      -- Every word has to appear somewhere in the name and code together, in
      -- any order. Passed as an array so the number of words cannot change the
      -- shape of the query.
      AND (${filters.searchWords ?? null}::text[] IS NULL
           OR (SELECT bool_and(i.name || ' ' || i.code ILIKE '%' || w || '%')
               FROM unnest(${filters.searchWords ?? null}::text[]) AS w))
    GROUP BY i.id, i.code, i.name, u.symbol, c.name, i."reorderLevel",
             w.id, w.name, s."ownership", s."ownerCustomerId", cust.name
    HAVING SUM(s."inQty" - s."outQty") <> 0
    ORDER BY i.name ASC, w.name ASC
  `

  return rows
    .map((r) => {
      const qty = round3(r.qty)
      const value = round2(r.value)
      const isLow = r.reorderLevel !== null && qty <= r.reorderLevel
      return {
        ...r,
        qty,
        value,
        avgRate: qty > 0 ? round2(value / qty) : 0,
        isLow,
      }
    })
    .filter((r) => (filters.lowOnly ? r.isLow : true))
}
