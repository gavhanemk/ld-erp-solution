import type { Prisma, StockOwnership, TransactionType } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { SAMPLE_STORE_IDS, sampleStoreMayMove, sampleStoreRefused } from '../lib/sampleStore'
// package.service imports this file too; each only calls the other from inside a function.
import { takeFromPackage } from './package.service'
import { currentUserId } from '../lib/requestContext'
import { OFFERING_STORE_IDS, storeOffers } from './availability.service'

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
 * And one about time: a movement is dated no earlier than the last movement of
 * the same item in the same store, and never after today (see `settleDate`).
 *
 * A finished garment's balance is also kept per size: a shirt in M and the
 * same shirt in XL are two balances, because a challan sends sizes, not
 * shirts. Everything without a size — fabric, trims, packing — passes no size
 * and keeps one balance per item, exactly as before sizes existed.
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
  /** A finished garment's size; left out for anything that has no size. */
  sizeId?: string | null
  /**
   * "A" (first quality) unless said otherwise; "B" for B-grade finished goods,
   * which are counted apart from good ones and never sent in their place.
   */
  grade?: 'A' | 'B' | string | null
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
  /**
   * Goods on the road only: what they leave a transit store at, which is what
   * their own transfer put them in at. One transit store carries every
   * consignment, and two of the same cloth sent at different rates must not
   * blend on the way; nothing else moves stock there, so each leaving at its
   * own rate keeps what is left exactly what is still on the road. Refused for
   * any other store.
   */
  atRate?: number
  /** The document that caused this. Both halves are required; see rule 2. */
  referenceType: string
  referenceId: string
  batchNumber?: string | null
  /**
   * The order the pieces belong to, on work in progress and finished goods
   * moved process to process. Written on the row; not part of the balance.
   */
  orderNo?: string | null
  transactionDate?: Date
  notes?: string | null
  /**
   * When the date asked for is earlier than the item's last movement in that
   * store: 'refuse' (the default) says so; 'move-up' writes it just after that
   * movement instead. For corrections, cancellations, approvals and
   * despatches — they happen now, whatever date their document carries.
   */
  earlierDate?: 'refuse' | 'move-up'
  /** Requisition lines whose own holds this movement may take: an issue uses up its own reservation. */
  reservedFor?: string[]
  /**
   * A delivery challan whose loaded cartons' pieces this movement may take:
   * pieces sealed in any other carton stay in the store until it is opened.
   */
  cartonsOn?: string
  /** A check or a count found it: the stock is what it is, holds or not. */
  ignoreReservations?: boolean
  /**
   * Who keeps the stickers in step when stock goes out. 'auto' (the default)
   * takes this store's stickers down to what is left, oldest first; 'window'
   * leaves it to the labels window after the document, where the store says
   * which rolls went; 'caller' to the caller, which moved a scanned package
   * itself or handles its own stickers.
   */
  stickers?: 'auto' | 'window' | 'caller'
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
  const token = lockToken(key)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${token})::bigint)`
}

/** The name a balance's lock goes by: everything that makes it one balance. */
function lockToken(key: StockKey): string {
  return [
    key.itemId,
    key.warehouseId,
    key.ownership ?? 'OWNED',
    key.ownerCustomerId ?? '',
    key.sizeId ?? '',
    key.grade ?? 'A',
  ].join('|')
}

/**
 * Locks several balances at once, always in the same order.
 *
 * A document that touches two balances — a transfer takes from one store and
 * puts into another — locking them in the order it meets them can deadlock
 * against one going the other way: A→B holds A and waits for B while B→A
 * holds B and waits for A. Taken in one fixed order, the second simply waits
 * for the first. Each lock is held to the end of the transaction, and taking
 * one again later (as `recordMovement` does) is harmless.
 */
export async function lockBalances(tx: Prisma.TransactionClient, keys: StockKey[]): Promise<void> {
  const tokens = [...new Set(keys.map(lockToken))].sort()
  for (const token of tokens) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${token})::bigint)`
}

/**
 * The same lock, and in the same round trip the store's name and whether it
 * is a sample store: recordMovement checks every movement against that, and
 * a second query per movement would be paid by every document in the mill.
 */
async function lockBalanceAndStore(
  tx: Prisma.TransactionClient,
  key: StockKey,
): Promise<{ purpose: string | null; name: string | null; kind: string | null }> {
  const token = lockToken(key)
  const rows = await tx.$queryRaw<Array<{ purpose: string | null; name: string | null; kind: string | null }>>`
    SELECT w.purpose::text AS purpose, w.name, w.kind::text AS kind
    FROM (SELECT pg_advisory_xact_lock(hashtext(${token})::bigint)) AS held
    LEFT JOIN ld_erp.warehouses w ON w.id = ${key.warehouseId}`
  return rows[0] ?? { purpose: null, name: null, kind: null }
}

/**
 * The documents that may move stock into or out of a transit store: an
 * in-transit transfer's dispatch, receipt, send-back, write-off and cancel.
 * Goods on the road are counted at the other end, not issued or counted where
 * they wait.
 */
export const TRANSIT_DOCUMENTS = new Set([
  'STOCK_TRANSFER',
  'STOCK_TRANSFER_RECEIVED',
  'STOCK_TRANSFER_RETURNED',
  'STOCK_TRANSFER_LOST',
  'STOCK_TRANSFER_CANCELLED',
])

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
      AND "sizeId" IS NOT DISTINCT FROM ${key.sizeId ?? null}::text
      AND "grade" = ${key.grade ?? 'A'}
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

/** The calendar day in India, as YYYY-MM-DD: what "dated the 28th" means at the mill. */
const indianDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10)

/**
 * The day the books are locked up to (Accounts → Chart of Accounts → Books),
 * as YYYY-MM-DD in India, or null when nothing is locked. Stock in a closed
 * period is closed too: its value is the closing stock those books carry.
 */
export async function stockLockedUpTo(tx: Prisma.TransactionClient): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ d: Date | null }>>`SELECT "booksLockedUpTo" AS d FROM ld_erp.company LIMIT 1`
  return rows[0]?.d ? indianDay(rows[0].d) : null
}

const readableDay = (d: Date) =>
  d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  })

/**
 * The date a movement is written with, or a refusal.
 *
 * Every balance check and every average rate here is worked out in the order
 * movements are entered. A movement dated before one already in the book for
 * the same item and store sits in the ledger out of that order: a transfer
 * back-dated to January was accepted for fabric that arrived in September,
 * and the running balance printed beside it was wrong. So a movement may be
 * dated any day from that item's last movement in that store up to today, and
 * not before.
 *
 * On the same day, a time no later than the last movement's is moved to just
 * after it, so every item and store's movements are dated strictly in the
 * order they were written (the lock makes that the order the balance was
 * worked out in). Two issues sent at once would otherwise carry the times
 * their requests arrived, not the order the lock let them through, and the
 * ledger would list their running balances out of step. Called with the
 * item's lock already held.
 */
async function settleDate(
  tx: Prisma.TransactionClient,
  key: StockKey & { transactionDate?: Date; earlierDate?: 'refuse' | 'move-up' },
): Promise<Date> {
  const now = new Date()
  const asked = key.transactionDate ?? now

  if (indianDay(asked) > indianDay(now)) {
    throw new AppError(
      `A stock entry cannot be dated after today. ${readableDay(asked)} is in the future.`,
      400,
      'FUTURE_DATE',
    )
  }

  const rows = await tx.$queryRaw<Array<{ last: Date | null }>>`
    SELECT MAX("transactionDate") AS last
    FROM ld_erp.stock_ledger
    WHERE "itemId" = ${key.itemId}
      AND "warehouseId" = ${key.warehouseId}
      AND "ownership" = ${key.ownership ?? 'OWNED'}::ld_erp."StockOwnership"
      AND "ownerCustomerId" IS NOT DISTINCT FROM ${key.ownerCustomerId ?? null}::text
      AND "sizeId" IS NOT DISTINCT FROM ${key.sizeId ?? null}::text
      AND "grade" = ${key.grade ?? 'A'}
  `
  const last = rows[0]?.last ?? null
  if (!last) return outsideLock(tx, asked, key.earlierDate)

  // A correction, a cancellation, an approval or a despatch happens now: it
  // goes in just after the last movement rather than being refused for the
  // date its document carries.
  if (key.earlierDate === 'move-up' && asked <= last) return outsideLock(tx, new Date(last.getTime() + 1), key.earlierDate)

  if (indianDay(asked) < indianDay(last)) {
    const [item, warehouse] = await Promise.all([
      tx.item.findUnique({ where: { id: key.itemId }, select: { name: true } }),
      tx.warehouse.findUnique({ where: { id: key.warehouseId }, select: { name: true } }),
    ])
    throw new AppError(
      `${item?.name ?? 'That item'} last moved in ${warehouse?.name ?? 'that store'} on ${readableDay(last)}. Date this ${readableDay(last)} or later — an earlier date would put it out of order and make the running balance wrong.`,
      400,
      'BEFORE_LAST_MOVEMENT',
    )
  }

  return outsideLock(tx, asked <= last ? new Date(last.getTime() + 1) : asked, key.earlierDate)
}

/**
 * A movement's date, kept out of a closed period: stock up to the lock date
 * is as the books closed it. A correction, cancellation or approval happens
 * now, so it is written now; anything else dated in the closed period is
 * refused, saying so.
 */
async function outsideLock(tx: Prisma.TransactionClient, when: Date, earlierDate?: 'refuse' | 'move-up'): Promise<Date> {
  const lock = await stockLockedUpTo(tx)
  if (!lock || indianDay(when) > lock) return when
  const now = new Date()
  if (earlierDate === 'move-up' && indianDay(now) > lock) return now
  throw new AppError(
    `Stock up to ${readableDay(new Date(`${lock}T00:00:00+05:30`))} is closed: the books are locked to that day (Accounts → Chart of Accounts → Books). Date this after it, or reopen the period first.`,
    400,
    'PERIOD_LOCKED',
  )
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
): Promise<{ balance: Balance; unitRate: number; ledgerId: string }> {
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

  const store = await lockBalanceAndStore(tx, m)
  // A sample store holds what was bought for samples, apart from bulk stock:
  // only the documents lib/sampleStore names may move stock in or out of it.
  if (store.purpose === 'SAMPLING' && !sampleStoreMayMove(m)) {
    throw sampleStoreRefused(store.name ?? 'That store', m.referenceType, m.ownership ?? 'OWNED')
  }
  // Goods on the road move only on their own transfer.
  if (store.kind === 'TRANSIT' && !TRANSIT_DOCUMENTS.has(m.referenceType)) {
    throw new AppError(
      `${store.name ?? 'That store'} holds goods on the road: they move only on their in-transit transfer. Receive them, send them back or write them off from Stock Documents → Transfers.`,
      400,
      'TRANSIT_STORE',
    )
  }
  if (m.atRate !== undefined && (m.direction !== 'OUT' || store.kind !== 'TRANSIT')) {
    throw new AppError('Only goods leaving a transit store go at their own transfer’s rate.', 500, 'RATE_NOT_ALLOWED')
  }

  const transactionDate = await settleDate(tx, m)
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
      const size = m.sizeId
        ? await tx.size.findUnique({ where: { id: m.sizeId }, select: { code: true } })
        : null
      const unit = item?.uom?.symbol ?? ''
      const what = `${m.grade === 'B' ? 'B-grade ' : ''}${item?.name ?? 'that item'}${size ? ` in size ${size.code}` : ''}`

      throw new AppError(
        `Only ${before.qty} ${unit} of ${what} in ${warehouse?.name ?? 'that warehouse'}. You are trying to take out ${qty}.`.replace(
          /\s+/g,
          ' ',
        ),
        400,
        'INSUFFICIENT_STOCK',
      )
    }
    // Stock kept aside for a requisition is not free for anything else to
    // take: a transfer, a job-work challan, a return or a cancellation would
    // otherwise leave the hold promising stock that is no longer there. The
    // requisition's own issue may use its own hold; a check or a count states
    // a fact, and is not refused for it.
    if (!m.ignoreReservations && (m.ownership ?? 'OWNED') === 'OWNED' && (m.grade ?? 'A') === 'A' && !m.sizeId) {
      const holds = await tx.$queryRaw<Array<{ qty: number; mrNumber: string; customer: string | null }>>`
        SELECT r.qty::float8 AS qty, mr."mrNumber", c.name AS customer
        FROM ld_erp.stock_reservations r
        JOIN ld_erp.material_requisitions mr ON mr.id = r."mrId"
        LEFT JOIN ld_erp.customers c ON c.id = r."customerId"
        WHERE r.status::text = 'ACTIVE' AND r."itemId" = ${m.itemId} AND r."warehouseId" = ${m.warehouseId}
          AND NOT (r."mrLineId" = ANY(${m.reservedFor ?? []}::text[]))`
      const held = round3(holds.reduce((t, h) => t + Number(h.qty), 0))
      const free = round3(Math.max(0, before.qty - held))
      if (held > 0 && qty > free + 1e-9) {
        const [item, warehouse] = await Promise.all([
          tx.item.findUnique({ where: { id: m.itemId }, select: { name: true, uom: { select: { symbol: true } } } }),
          tx.warehouse.findUnique({ where: { id: m.warehouseId }, select: { name: true } }),
        ])
        const unit = item?.uom?.symbol ?? ''
        const whom = [...new Set(holds.map((h) => (h.customer ? `${h.mrNumber} (${h.customer})` : h.mrNumber)))].join(', ')
        throw new AppError(
          `Only ${free} ${unit} of ${item?.name ?? 'that item'} in ${warehouse?.name ?? 'that store'} is free: ${held} ${unit} is kept aside for ${whom}. Take ${free} or less, or release the hold on the requisition first.`.replace(/\s+/g, ' '),
          400,
          'RESERVED_STOCK',
        )
      }
    }
    // Pieces sealed in a carton are not free either: they leave with their
    // carton on its challan, or the carton is opened first. A check or a count
    // states a fact, and is not refused for it.
    if (!m.ignoreReservations && (m.ownership ?? 'OWNED') === 'OWNED' && m.sizeId) {
      const sealed = await tx.$queryRaw<Array<{ qty: number; codes: string[] | null }>>`
        SELECT COALESCE(SUM(l.qty), 0)::float8 AS qty, array_agg(DISTINCT c.code ORDER BY c.code) AS codes
        FROM ld_erp.fg_carton_lines l JOIN ld_erp.fg_cartons c ON c.id = l."cartonId"
        WHERE c.status::text = 'PACKED' AND l."itemId" = ${m.itemId} AND c."warehouseId" = ${m.warehouseId}
          AND l."sizeId" = ${m.sizeId} AND l.grade = ${m.grade ?? 'A'}
          AND (c."dcId" IS NULL OR c."dcId" <> ${m.cartonsOn ?? ''})`
      const packed = round3(Number(sealed[0]?.qty ?? 0))
      const free = round3(Math.max(0, before.qty - packed))
      if (packed > 0 && qty > free + 1e-9) {
        const [item, warehouse, size] = await Promise.all([
          tx.item.findUnique({ where: { id: m.itemId }, select: { name: true } }),
          tx.warehouse.findUnique({ where: { id: m.warehouseId }, select: { name: true } }),
          tx.size.findUnique({ where: { id: m.sizeId }, select: { code: true } }),
        ])
        const codes = (sealed[0]?.codes ?? []).filter(Boolean)
        throw new AppError(
          `Only ${free} pcs of ${item?.name ?? 'that item'} size ${size?.code ?? ''} in ${warehouse?.name ?? 'that store'} are loose: ${packed} are sealed in ${codes.length === 1 ? 'carton' : 'cartons'} ${codes.slice(0, 6).join(', ')}${codes.length > 6 ? '…' : ''}. Load the cartons on the challan (Finished Goods → Cartons → Dispatch), or open a carton first.`.replace(/\s+/g, ' '),
          400,
          'PACKED_IN_CARTONS',
        )
      }
    }
    // Stock leaves at what it is carried at. Any other rate would leave value
    // behind that no quantity accounts for. Goods on the road leave at what
    // their own transfer put them in at (see `atRate`).
    unitRate = m.atRate !== undefined ? round2(m.atRate) : before.avgRate
    if (m.atRate !== undefined && before.value - qty * unitRate < -0.05) {
      throw new AppError(
        `The transit store carries only ₹${before.value} of this item, less than the ${qty} going out at ₹${unitRate}. Run the Stock Reconciliation report before going on.`,
        409,
        'TRANSIT_VALUE',
      )
    }
  }

  const closing = round3(m.direction === 'IN' ? before.qty + qty : before.qty - qty)

  const row = await tx.stockLedger.create({
    select: { id: true },
    data: {
      itemId: m.itemId,
      warehouseId: m.warehouseId,
      transactionType: m.transactionType,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      batchNumber: m.batchNumber ?? null,
      orderNo: m.orderNo ?? null,
      ownership: m.ownership ?? 'OWNED',
      ownerCustomerId: m.ownerCustomerId ?? null,
      sizeId: m.sizeId ?? null,
      grade: m.grade ?? 'A',
      inQty: m.direction === 'IN' ? qty : 0,
      outQty: m.direction === 'OUT' ? qty : 0,
      // A snapshot for the ledger view to print, so a printed statement does
      // not have to re-add every earlier row. The sum of the rows is still
      // what `balanceOf` trusts.
      closingStock: closing,
      unitRate,
      transactionDate,
      notes: m.notes ?? null,
      // Who asked for it: the signed-in user of the request this runs in.
      createdById: currentUserId(),
    },
  })

  if (m.direction === 'OUT' && (m.stickers ?? 'auto') === 'auto' && !m.sizeId) await keepStickersInStep(tx, m)

  return { balance: await balanceOf(tx, m), unitRate, ledgerId: row.id }
}

/**
 * Stickers never claim more than the store holds.
 *
 * Stock that goes out by a form rather than a scan — a typed issue, a debit
 * note, a count, a cancellation, what a job worker used up — leaves its rolls'
 * stickers saying they are still full. Straight after it, the stickers of that
 * item in that store are taken down to what is left, the oldest first, as a
 * store issues: a whole roll's sticker is emptied, and a roll only partly gone
 * keeps its sticker with what is left in it.
 * Rejected stock held in the same store still has its rolls, so it counts.
 */
async function keepStickersInStep(tx: Prisma.TransactionClient, m: Movement) {
  const ownership = m.ownership ?? 'OWNED'
  const owner = m.ownerCustomerId ?? null
  const packages = await tx.stockPackage.findMany({
    where: { itemId: m.itemId, warehouseId: m.warehouseId, ownership, ownerCustomerId: owner, status: 'IN_STOCK' },
    orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
  })
  if (!packages.length) return
  // Stickers of the grade that went out come down first: usable stock going
  // out never takes a held roll's sticker down while a usable one is left.
  const grade = m.grade ?? 'A'
  packages.sort((a, b) => Number(b.grade === grade) - Number(a.grade === grade))
  const [row] = await tx.$queryRaw<Array<{ qty: number }>>`
    SELECT COALESCE(SUM("inQty" - "outQty"), 0)::float8 AS qty
    FROM ld_erp.stock_ledger
    WHERE "itemId" = ${m.itemId} AND "warehouseId" = ${m.warehouseId}
      AND ownership = ${ownership}::ld_erp."StockOwnership"
      AND "ownerCustomerId" IS NOT DISTINCT FROM ${owner}::text
      AND "sizeId" IS NULL AND grade IN ('A', 'R')`
  let over = round3(packages.reduce((t, p) => t + Number(p.qty), 0) - Number(row?.qty ?? 0))
  for (const p of packages) {
    if (over <= 0.0005) break
    const take = round3(Math.min(Number(p.qty), over))
    const went = `Stock went out without a scan${m.notes ? ` (${m.notes})` : ''}`
    const whole = take >= Number(p.qty) - 0.0005
    const left = round3(Number(p.qty) - take)
    await takeFromPackage(tx, p, take, {
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      notes: whole ? `${went}: the sticker is taken down with it.` : `${went}: ${left} left on this sticker.`,
    })
    over = round3(over - take)
  }
}

/**
 * Whether the stock a document brought in is still all there — refused when
 * it is not.
 *
 * Cancelling, deleting or cutting down a document that brought stock in takes
 * that stock back out. The store's balance alone does not say it is this
 * document's goods that are left: with other stock of the item in the store, a
 * receipt whose rolls were all issued could still be cancelled, and the book
 * would end up below what is on the rack. So it is read first in, first out —
 * the document's goods are used once more has gone out of that store since
 * they came in than the store held before them — unless the document's own
 * stickers show its rolls still whole on the rack. `take` is how much would
 * come back out, item by item and store by store; left out, all of it.
 */
export async function assertStockUnused(
  tx: Prisma.TransactionClient,
  args: { referenceId: string; label: string; take?: Map<string, number>; suggestion?: string },
) {
  const keyOf = (r: { itemId: string; warehouseId: string }) => `${r.itemId}|${r.warehouseId}`
  const mine = await tx.$queryRaw<
    Array<{ itemId: string; warehouseId: string; ownership: string; ownerCustomerId: string | null; sizeId: string | null; grade: string; net: number; since: Date }>
  >`
    SELECT "itemId", "warehouseId", ownership::text AS ownership, "ownerCustomerId", "sizeId", grade,
           SUM("inQty" - "outQty")::float8 AS net, MIN("createdAt") FILTER (WHERE "inQty" > 0) AS since
    FROM ld_erp.stock_ledger
    WHERE "referenceId" = ${args.referenceId}
    GROUP BY 1, 2, 3, 4, 5, 6
    HAVING SUM("inQty" - "outQty") > 0.0005`

  // Its own stickers say what became of its goods, whatever first-in-first-out
  // would guess: a roll of it scanned out, used up or cut down is gone. Each
  // sticker it made is followed through its splits; whatever of them is not
  // still on stock in the store it came into has been used.
  if (!args.take) {
    const roots = await tx.stockPackage.findMany({
      where: { sourceId: args.referenceId, parentId: null, status: { not: 'VOID' } },
      select: { id: true, code: true, itemId: true, warehouseId: true, initialQty: true },
    })
    for (const spot of new Map(mine.map((k) => [keyOf(k), k])).values()) {
      const own = roots.filter((r) => r.itemId === spot.itemId)
      if (!own.length) continue
      const family = new Set(own.map((r) => r.id))
      for (let parents = [...family]; parents.length; ) {
        const children = await tx.stockPackage.findMany({ where: { parentId: { in: parents } }, select: { id: true } })
        parents = children.map((c) => c.id).filter((id) => !family.has(id))
        parents.forEach((id) => family.add(id))
      }
      const [left] = await tx.$queryRaw<Array<{ qty: number }>>`
        SELECT COALESCE(SUM(qty), 0)::float8 AS qty FROM ld_erp.stock_packages
        WHERE id = ANY(${[...family]}::text[]) AND status = 'IN_STOCK' AND "warehouseId" = ${spot.warehouseId}`
      const labelled = own.reduce((t, r) => t + Number(r.initialQty), 0)
      const gone = round3(labelled - Number(left?.qty ?? 0))
      if (gone <= 0.0005) continue
      const [item, used] = await Promise.all([
        tx.item.findUnique({ where: { id: spot.itemId }, select: { name: true, uom: { select: { symbol: true } } } }),
        tx.stockPackageMove.findMany({
          where: { packageId: { in: [...family] }, type: { in: ['ISSUED', 'TRANSFERRED'] } },
          select: { referenceNumber: true },
          distinct: ['referenceNumber'],
          take: 3,
        }),
      ])
      const onWhat = used.map((u) => u.referenceNumber).filter(Boolean).join(', ')
      throw new AppError(
        `${gone} ${item?.uom?.symbol ?? ''} of the ${item?.name ?? 'item'} that came in on ${args.label} has already gone out by its stickers${onWhat ? ` (${onWhat})` : ''}, so ${args.label} cannot take it back. ${args.suggestion ?? 'Send what is left back with a return, or correct the stock with a stock adjustment.'}`.replace(/\s+/g, ' '),
        409,
        'STOCK_ALREADY_USED',
      )
    }
  }

  for (const k of mine) {
    const want = args.take ? (args.take.get(keyOf(k)) ?? 0) : Number(k.net)
    if (!(want > 0.0005) || !k.since) continue
    // Its own stickers still whole on the rack prove its goods are there.
    const own = await tx.stockPackage.findMany({
      where: { itemId: k.itemId, warehouseId: k.warehouseId, sourceId: args.referenceId, parentId: null, status: { not: 'VOID' } },
      select: { qty: true, initialQty: true, status: true },
    })
    const whole = own.filter((p) => p.status === 'IN_STOCK' && Math.abs(Number(p.qty) - Number(p.initialQty)) < 0.0005).reduce((t, p) => t + Number(p.qty), 0)
    if (own.length && whole + 0.0005 >= want) continue

    const [b] = await tx.$queryRaw<Array<{ before: number; outs: number }>>`
      SELECT
        COALESCE(SUM("inQty" - "outQty") FILTER (WHERE "createdAt" < ${k.since}), 0)::float8 AS before,
        COALESCE(SUM("outQty") FILTER (WHERE "createdAt" >= ${k.since} AND "referenceId" <> ${args.referenceId}), 0)::float8 AS outs
      FROM ld_erp.stock_ledger
      WHERE "itemId" = ${k.itemId} AND "warehouseId" = ${k.warehouseId}
        AND ownership = ${k.ownership}::ld_erp."StockOwnership"
        AND "ownerCustomerId" IS NOT DISTINCT FROM ${k.ownerCustomerId}::text
        AND "sizeId" IS NOT DISTINCT FROM ${k.sizeId}::text AND grade = ${k.grade}`
    const used = round3(Math.min(Number(k.net), Math.max(0, Number(b.outs) - Number(b.before))))
    const unused = round3(Number(k.net) - used)
    if (want <= unused + 0.0005) continue

    const [item, warehouse, went] = await Promise.all([
      tx.item.findUnique({ where: { id: k.itemId }, select: { name: true, uom: { select: { symbol: true } } } }),
      tx.warehouse.findUnique({ where: { id: k.warehouseId }, select: { name: true } }),
      tx.$queryRaw<Array<{ notes: string | null; referenceType: string }>>`
        SELECT notes, "referenceType" FROM ld_erp.stock_ledger
        WHERE "itemId" = ${k.itemId} AND "warehouseId" = ${k.warehouseId} AND "createdAt" >= ${k.since}
          AND "referenceId" <> ${args.referenceId} AND "outQty" > 0
        ORDER BY "createdAt" LIMIT 3`,
    ])
    const unit = item?.uom?.symbol ?? ''
    const onWhat = went.map((w) => (w.notes ?? w.referenceType).split(':')[0]).join('; ')
    throw new AppError(
      `${used} ${unit} of the ${item?.name ?? 'item'} that came in on ${args.label} has already gone out of ${warehouse?.name ?? 'the store'}${onWhat ? ` (${onWhat})` : ''}, so ${args.label} cannot take it back. ${args.suggestion ?? 'Send what is left back with a return, or correct the stock with a stock adjustment.'}`.replace(/\s+/g, ' '),
      409,
      'STOCK_ALREADY_USED',
    )
  }
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
    /** A finished garment's size: it moves as that size, and arrives as it. */
    sizeId?: string | null
    grade?: string | null
    /** The lot and the order travel with the pieces, written on both rows. */
    batchNumber?: string | null
    orderNo?: string | null
    transactionDate?: Date
    notes?: string | null
    /** As on a single movement: see `Movement`. Stickers and holds apply to the side it leaves. */
    stickers?: Movement['stickers']
    earlierDate?: Movement['earlierDate']
    reservedFor?: string[]
    ignoreReservations?: boolean
    /** Out of a transit store: the rate its own transfer put it in at (see `Movement.atRate`). */
    atRate?: number
    /** The grade it arrives as, when not the one it left as: goods that came in damaged arrive as R. */
    toGrade?: string | null
  },
): Promise<{ unitRate: number }> {
  if (args.fromWarehouseId === args.toWarehouseId) {
    throw new AppError(
      'The two warehouses are the same, so nothing would move',
      400,
      'SAME_WAREHOUSE',
    )
  }

  // Both balances locked up front, in one fixed order: two transfers going
  // opposite ways between the same stores would otherwise deadlock.
  const whose = { ownership: args.ownership, ownerCustomerId: args.ownerCustomerId, sizeId: args.sizeId, grade: args.grade }
  const arrivesAs = args.toGrade ?? args.grade
  await lockBalances(tx, [
    { itemId: args.itemId, warehouseId: args.fromWarehouseId, ...whose },
    { itemId: args.itemId, warehouseId: args.toWarehouseId, ...whose, grade: arrivesAs },
  ])

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
    sizeId: args.sizeId,
    grade: args.grade,
    batchNumber: args.batchNumber,
    orderNo: args.orderNo,
    transactionDate: args.transactionDate,
    notes: args.notes,
    stickers: args.stickers,
    earlierDate: args.earlierDate,
    reservedFor: args.reservedFor,
    ignoreReservations: args.ignoreReservations,
    ...(args.atRate !== undefined ? { atRate: args.atRate } : {}),
  })

  await recordMovement(tx, {
    itemId: args.itemId,
    warehouseId: args.toWarehouseId,
    transactionType: 'TRANSFER',
    direction: 'IN',
    qty: args.qty,
    // At what it left at, always: a move across the yard neither makes nor
    // loses value. Stock carried at nothing (a customer's, or an opening line
    // whose rate is still pending) arrives at nothing; setting the opening
    // rate later prices both halves of the move (openingControl.repriceFrom).
    unitRate: out.unitRate,
    referenceType: args.referenceType,
    referenceId: args.referenceId,
    ownership: args.ownership,
    ownerCustomerId: args.ownerCustomerId,
    sizeId: args.sizeId,
    grade: arrivesAs,
    batchNumber: args.batchNumber,
    orderNo: args.orderNo,
    transactionDate: args.transactionDate,
    notes: args.notes,
    earlierDate: args.earlierDate,
  })
  return { unitRate: out.unitRate }
}

/**
 * Which items need reordering: the one answer every screen gives.
 *
 * An item needs reordering when our own stock of it, every store together, is
 * at or below its reorder level. Four screens used to work this out four ways:
 * the stock list store by store (so an item split across two stores could be
 * low in one and fine overall, and one with nothing anywhere never showed up at
 * all), the dashboard counting a customer's fabric as ours. Now there is this.
 *
 * Only active items with a reorder level above nought. An item that has never
 * moved is at nought, which is below any reorder level, and is included.
 */
export async function reorderStatus(
  tx: Prisma.TransactionClient,
  filters: { itemId?: string } = {},
): Promise<
  Array<{
    itemId: string
    itemCode: string
    itemName: string
    uom: string
    categoryId: string
    categoryName: string
    reorderLevel: number
    onHand: number
    isLow: boolean
  }>
> {
  const rows = await tx.$queryRaw<
    Array<{
      itemId: string
      itemCode: string
      itemName: string
      uom: string
      categoryId: string
      categoryName: string
      reorderLevel: number
      onHand: number
    }>
  >`
    SELECT
      i.id                                   AS "itemId",
      i.code                                 AS "itemCode",
      i.name                                 AS "itemName",
      u.symbol                               AS "uom",
      i."categoryId"                         AS "categoryId",
      c.name                                 AS "categoryName",
      i."reorderLevel"::float8               AS "reorderLevel",
      COALESCE(SUM(s."inQty" - s."outQty") FILTER (WHERE s."ownership" = 'OWNED'), 0)::float8 AS "onHand"
    FROM ld_erp.items i
    JOIN ld_erp.uom             u ON u.id = i."uomId"
    JOIN ld_erp.item_categories c ON c.id = i."categoryId"
    -- By the one rule (services/availability.service): good stock in stores
    -- that issue. Samples, rejects, QC holds, scrap and goods in transit are
    -- not stock the mill reorders against.
    LEFT JOIN ld_erp.stock_ledger s ON s."itemId" = i.id AND s.grade = 'A' AND s."warehouseId" IN (${OFFERING_STORE_IDS})
    WHERE i."isActive" = true
      AND i."reorderLevel" > 0
      AND (${filters.itemId ?? null}::text IS NULL OR i.id = ${filters.itemId ?? null})
    GROUP BY i.id, i.code, i.name, u.symbol, i."categoryId", c.name, i."reorderLevel"
    ORDER BY i.name ASC
  `
  return rows.map((r) => {
    const onHand = round3(r.onHand)
    return { ...r, onHand, isLow: onHand <= r.reorderLevel }
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
    /**
     * Only items that need reordering (see `reorderStatus`), with a row for
     * each that has nothing in any store, since that is the most urgent.
     */
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
    /** Of qty: good stock (grade A), B-grade, and held or rejected (grade R). */
    good: number
    bGrade: number
    held: number
    /** What kind of store it is (Masters → Warehouses). */
    storeKind: string
    /** Held for requisitions, of the good stock. */
    reserved: number
    /** Free by the one rule: good stock in a store that issues, less what is held. */
    free: number
    value: number
    avgRate: number
    /** The item needs reordering: our own stock, every store together, is at or below its reorder level. */
    isLow: boolean
    /** Our own stock of the item in every store together, where it has a reorder level. */
    itemOnHand: number | null
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
      good: number
      bGrade: number
      held: number
      storeKind: string
      storePurpose: string
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
      w.kind::text                           AS "storeKind",
      w.purpose::text                        AS "storePurpose",
      s."ownership"                          AS "ownership",
      s."ownerCustomerId"                    AS "ownerCustomerId",
      cust.name                              AS "ownerName",
      SUM(s."inQty" - s."outQty")::float8    AS "qty",
      -- Every grade apart: good, B-grade, and held or rejected.
      COALESCE(SUM(s."inQty" - s."outQty") FILTER (WHERE s.grade = 'A'), 0)::float8 AS "good",
      COALESCE(SUM(s."inQty" - s."outQty") FILTER (WHERE s.grade = 'B'), 0)::float8 AS "bGrade",
      COALESCE(SUM(s."inQty" - s."outQty") FILTER (WHERE s.grade NOT IN ('A', 'B')), 0)::float8 AS "held",
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
             w.id, w.name, w.kind, w.purpose, s."ownership", s."ownerCustomerId", cust.name
    HAVING SUM(s."inQty" - s."outQty") <> 0
    ORDER BY i.name ASC, w.name ASC
  `

  const status = new Map((await reorderStatus(tx, { itemId: filters.itemId })).map((r) => [r.itemId, r]))
  // Held for requisitions, by item and store: only our own good stock is ever held.
  const holds = new Map(
    (
      await tx.stockReservation.groupBy({ by: ['itemId', 'warehouseId'], where: { status: 'ACTIVE' }, _sum: { qty: true } })
    ).map((h) => [`${h.itemId}|${h.warehouseId}`, Number(h._sum.qty ?? 0)]),
  )

  const out = rows
    .map((r) => {
      const { storePurpose, ...row } = r
      const qty = round3(r.qty)
      const value = round2(r.value)
      const item = status.get(r.itemId)
      const good = round3(r.good)
      const offers = storeOffers({ purpose: storePurpose, kind: r.storeKind })
      const reserved = r.ownership === 'OWNED' ? round3(Math.min(Math.max(good, 0), holds.get(`${r.itemId}|${r.warehouseId}`) ?? 0)) : 0
      return {
        ...row,
        qty,
        good,
        bGrade: round3(r.bGrade),
        held: round3(r.held),
        reserved,
        free: offers ? round3(Math.max(0, good - reserved)) : 0,
        value,
        avgRate: qty > 0 ? round2(value / qty) : 0,
        // A customer's fabric is not ours to reorder.
        isLow: r.ownership === 'OWNED' && Boolean(item?.isLow),
        itemOnHand: item ? item.onHand : null,
      }
    })
    .filter((r) => (filters.lowOnly ? r.isLow : true))

  // Asked for what needs reordering: an item with nothing in any store has no
  // row above, and it is the one most in need.
  if (filters.lowOnly && !filters.warehouseId && !filters.ownership?.startsWith('CUSTOMER')) {
    const shown = new Set(out.map((r) => r.itemId))
    const words = (filters.searchWords ?? []).map((w) => w.toLowerCase())
    const text = filters.search?.toLowerCase()
    for (const item of status.values()) {
      if (!item.isLow || shown.has(item.itemId)) continue
      if (filters.categoryId && item.categoryId !== filters.categoryId) continue
      const hay = `${item.itemName} ${item.itemCode}`.toLowerCase()
      if (text && !hay.includes(text)) continue
      if (words.length && !words.every((w) => hay.includes(w))) continue
      out.push({
        itemId: item.itemId,
        itemCode: item.itemCode,
        itemName: item.itemName,
        uom: item.uom,
        categoryName: item.categoryName,
        reorderLevel: item.reorderLevel,
        warehouseId: '',
        warehouseName: 'None in any store',
        storeKind: 'GENERAL',
        ownership: 'OWNED',
        ownerCustomerId: null,
        ownerName: null,
        qty: 0,
        good: 0,
        bGrade: 0,
        held: 0,
        reserved: 0,
        free: 0,
        value: 0,
        avgRate: 0,
        isLow: true,
        itemOnHand: item.onHand,
        lastMovedAt: null,
      })
    }
    out.sort((a, b) => a.itemName.localeCompare(b.itemName))
  }

  return out
}
