import { prisma } from '@ld-erp/database'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { nextDocumentNumber } from '../lib/docNumber'
import { normaliseCode, packageRules, round3 } from './package.service'
import { afterCountDecided } from './stockCountHooks.service'
import { createAdjustment } from '../routes/inventory.routes'

/*
 * A stock count made by scanning stickers.
 *
 * The store keeper starts a count for one store and walks its racks scanning
 * every package. Each scan says at once what it is: here and in stock, booked
 * to another store, emptied or withdrawn, or no sticker of ours. Stock kept
 * without stickers is counted by hand alongside. Finishing sets what was found
 * against the book and raises an ordinary stock adjustment for the
 * differences — the same store manager approves it as any count — and the
 * stickers nobody found are withdrawn once it is approved.
 *
 * A count covers the whole store, or only the items scanned: one rack counted
 * on a quiet afternoon must not write off every box on the others.
 */

type Db = Prisma.TransactionClient | typeof prisma
type Ownership = 'OWNED' | 'CUSTOMER_OWNED'
export type CountScope = 'STORE' | 'SCANNED'

export const startCountSchema = z.object({
  warehouseId: z.string().min(1, 'Pick the store being counted'),
  notes: z.string().trim().max(500).optional().nullable(),
})
export const scanSchema = z.object({ code: z.string().trim().min(1, 'Scan a sticker, or type its number').max(120) })
export const looseSchema = z.object({
  lines: z
    .array(
      z.object({
        itemId: z.string().min(1),
        ownership: z.enum(['OWNED', 'CUSTOMER_OWNED']).default('OWNED'),
        ownerCustomerId: z.string().nullable().optional(),
        /** What is on the rack; null takes the item out of the count again. */
        qty: z.number().min(0, 'A count cannot be below nothing').max(9_999_999, 'That quantity looks like a typo').nullable(),
      }),
    )
    .max(1000),
})
export const submitSchema = z.object({ scope: z.enum(['STORE', 'SCANNED']).default('STORE') })
export const cancelCountSchema = z.object({ reason: z.string().trim().min(3, 'Say why the count is being dropped').max(500) })

const STATUS_WORD: Record<string, string> = { OPEN: 'still being counted', SUBMITTED: 'waiting for a store manager', CLOSED: 'closed', CANCELLED: 'cancelled' }
const spotKey = (s: { itemId: string; ownership: string; ownerCustomerId: string | null }) => `${s.itemId}|${s.ownership}|${s.ownerCustomerId ?? ''}`
const clock = (d: Date) => d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })

async function lockCount(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.stock_counts WHERE id = ${id} FOR UPDATE`
  const c = await tx.stockCount.findUnique({ where: { id }, include: { warehouse: { select: { id: true, name: true } } } })
  if (!c) throw new AppError('That stock count does not exist', 404, 'NOT_FOUND')
  return c
}
function mustBeOpen(c: { countNumber: string; status: string }) {
  if (c.status !== 'OPEN') throw new AppError(`${c.countNumber} is ${STATUS_WORD[c.status] ?? c.status.toLowerCase()}, so it can no longer be changed.`, 409, 'NOT_OPEN')
}

// ── Starting, scanning, counting by hand, dropping ─────────────────────────

/** A new count for one store — one at a time per store, so two counts never correct the same stock. */
export async function startCount(tx: Prisma.TransactionClient, d: z.infer<typeof startCountSchema>, userId: string | null) {
  const wh = await tx.warehouse.findUnique({ where: { id: d.warehouseId }, select: { name: true, isActive: true } })
  if (!wh) throw new AppError('That store does not exist', 404, 'NOT_FOUND')
  if (!wh.isActive) throw new AppError(`${wh.name} is switched off`, 400, 'INACTIVE')
  await tx.$queryRaw`SELECT id FROM ld_erp.warehouses WHERE id = ${d.warehouseId} FOR UPDATE`
  const open = await tx.stockCount.findFirst({ where: { warehouseId: d.warehouseId, status: { in: ['OPEN', 'SUBMITTED'] } }, select: { countNumber: true, status: true } })
  if (open) {
    throw new AppError(
      open.status === 'OPEN'
        ? `${open.countNumber} is already counting ${wh.name}. Carry on with that one, or cancel it first.`
        : `${open.countNumber} for ${wh.name} is waiting for a store manager. Start a new count once it is approved or refused.`,
      409,
      'COUNT_OPEN',
    )
  }
  return tx.stockCount.create({
    data: { countNumber: await nextDocumentNumber(tx, 'SC', new Date()), warehouseId: d.warehouseId, notes: d.notes?.trim() || null, startedById: userId },
  })
}

const scanSelect = {
  id: true,
  code: true,
  result: true,
  qty: true,
  scannedAt: true,
  scannedBy: { select: { name: true } },
  package: {
    select: {
      id: true,
      code: true,
      status: true,
      qty: true,
      packType: true,
      lotNo: true,
      warehouseId: true,
      warehouse: { select: { name: true } },
      item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
      ownerCustomer: { select: { name: true } },
    },
  },
} satisfies Prisma.StockCountScanSelect

type ScanRow = Prisma.StockCountScanGetPayload<{ select: typeof scanSelect }>

/** A scan as the screen shows it, with one plain line saying what it means. */
function shapeScan(s: ScanRow, warehouseId: string) {
  const p = s.package
  const unit = p?.item.uom?.symbol ?? ''
  const qty = s.qty == null ? null : Number(s.qty)
  // Moved or issued since it was scanned here: no longer counts.
  const gone = s.result === 'FOUND' && p && (p.status !== 'IN_STOCK' || p.warehouseId !== warehouseId)
  const note =
    s.result === 'FOUND'
      ? gone
        ? `Counted here, but it has since ${p!.status !== 'IN_STOCK' ? 'been issued or emptied' : `moved to ${p!.warehouse.name}`}, so it no longer counts.`
        : `${qty ?? 0} ${unit} ${p?.item.name ?? ''}`.trim()
      : s.result === 'ELSEWHERE'
        ? `Booked to ${p?.warehouse.name ?? 'another store'}. Move it here with Scan → Move, or take it back where it belongs. It is not counted here.`
        : s.result === 'NOT_IN_STOCK'
          ? `The system shows it ${p?.status === 'SPLIT' ? 'split into smaller packages' : p?.status === 'VOID' ? 'withdrawn' : 'empty — everything in it was issued'}. Check what is in it; it is not counted.`
          : /^G-?\d/i.test(s.code)
            ? 'That is a garment tag. Garments are counted on Garment In / Out.'
            : 'No sticker with this number on the system. Check the label.'
  return {
    id: s.id,
    code: s.code,
    result: gone ? 'GONE' : s.result,
    qty,
    unit,
    item: p ? { code: p.item.code, name: p.item.name } : null,
    owner: p?.ownerCustomer?.name ?? null,
    packType: p?.packType ?? null,
    lotNo: p?.lotNo ?? null,
    store: p?.warehouse.name ?? null,
    at: s.scannedAt,
    by: s.scannedBy?.name ?? null,
    note,
  }
}

/** One sticker scanned. A sticker already counted is refused, saying when and by whom. */
export async function scanPackage(tx: Prisma.TransactionClient, countId: string, raw: string, userId: string | null) {
  const c = await lockCount(tx, countId)
  mustBeOpen(c)
  const code = normaliseCode(raw)
  const had = await tx.stockCountScan.findUnique({ where: { countId_code: { countId, code } }, select: { scannedAt: true, scannedBy: { select: { name: true } } } })
  if (had) throw new AppError(`${code} is already counted — at ${clock(had.scannedAt)}${had.scannedBy ? ` by ${had.scannedBy.name}` : ''}.`, 409, 'ALREADY_SCANNED')
  const pkg = await tx.stockPackage.findUnique({ where: { code }, select: { id: true, status: true, warehouseId: true, qty: true } })
  const result = !pkg ? 'UNKNOWN' : pkg.status !== 'IN_STOCK' ? 'NOT_IN_STOCK' : pkg.warehouseId === c.warehouseId ? 'FOUND' : 'ELSEWHERE'
  const made = await tx.stockCountScan.create({
    data: { countId, code, packageId: pkg?.id ?? null, result, qty: pkg ? pkg.qty : null, scannedById: userId },
    select: scanSelect,
  })
  return shapeScan(made, c.warehouseId)
}

/** A scan taken back: the wrong sticker, or one scanned by mistake. */
export async function undoScan(tx: Prisma.TransactionClient, countId: string, scanId: string) {
  const c = await lockCount(tx, countId)
  mustBeOpen(c)
  const gone = await tx.stockCountScan.deleteMany({ where: { id: scanId, countId } })
  if (!gone.count) throw new AppError('That scan is not on this count.', 404, 'NOT_FOUND')
  return { code: c.countNumber }
}

/** Stock kept without stickers, counted by hand. A null quantity takes the item out of the count again. */
export async function setLoose(tx: Prisma.TransactionClient, countId: string, d: z.infer<typeof looseSchema>) {
  const c = await lockCount(tx, countId)
  mustBeOpen(c)
  const loose: Record<string, number> = { ...((c.loose as Record<string, number> | null) ?? {}) }
  for (const l of d.lines) {
    const key = spotKey({ itemId: l.itemId, ownership: l.ownership, ownerCustomerId: l.ownership === 'CUSTOMER_OWNED' ? (l.ownerCustomerId ?? null) : null })
    if (l.qty == null) delete loose[key]
    else loose[key] = round3(l.qty)
  }
  await tx.stockCount.update({ where: { id: countId }, data: { loose } })
  return loose
}

export async function cancelCount(tx: Prisma.TransactionClient, countId: string, reason: string) {
  const c = await lockCount(tx, countId)
  mustBeOpen(c)
  return tx.stockCount.update({ where: { id: countId }, data: { status: 'CANCELLED', cancelReason: reason, closedAt: new Date() } })
}

// ── What the count shows ───────────────────────────────────────────────────

/**
 * The count as it stands, item by item: what the book says, what is in
 * stickers, what was scanned and what was counted by hand — and so what the
 * adjustment would be. Read live, so a box issued while the count runs is
 * neither missed nor counted twice.
 */
export async function reviewOf(db: Db, c: { id: string; warehouseId: string; loose: Prisma.JsonValue }, scope: CountScope) {
  const [packages, scans, ledger, ruleOf] = await Promise.all([
    db.stockPackage.findMany({
      where: { warehouseId: c.warehouseId, status: 'IN_STOCK' },
      select: { id: true, code: true, itemId: true, ownership: true, ownerCustomerId: true, qty: true, packType: true, lotNo: true },
      orderBy: { code: 'asc' },
    }),
    db.stockCountScan.findMany({ where: { countId: c.id }, orderBy: { scannedAt: 'desc' }, select: scanSelect }),
    db.$queryRaw<Array<{ itemId: string; ownership: Ownership; ownerCustomerId: string | null; qty: number }>>`
      SELECT "itemId", ownership::text AS ownership, "ownerCustomerId", COALESCE(SUM("inQty" - "outQty"), 0)::float8 AS qty
      FROM ld_erp.stock_ledger
      WHERE "warehouseId" = ${c.warehouseId} AND "sizeId" IS NULL AND grade = 'A'
      GROUP BY 1, 2, 3
      HAVING ROUND(SUM("inQty" - "outQty")::numeric, 3) <> 0`,
    packageRules(db as Prisma.TransactionClient),
  ])
  const loose = (c.loose as Record<string, number> | null) ?? {}
  const here = new Map(packages.map((p) => [p.id, p]))
  const found = new Set(scans.filter((s) => s.result === 'FOUND' && s.package && here.has(s.package.id)).map((s) => s.package!.id))

  type Spot = { itemId: string; ownership: Ownership; ownerCustomerId: string | null; book: number; inPackages: number; packages: number; scannedQty: number; scanned: number }
  const spots = new Map<string, Spot>()
  const spotOf = (s: { itemId: string; ownership: Ownership; ownerCustomerId: string | null }) => {
    const k = spotKey(s)
    let v = spots.get(k)
    if (!v) spots.set(k, (v = { itemId: s.itemId, ownership: s.ownership, ownerCustomerId: s.ownerCustomerId, book: 0, inPackages: 0, packages: 0, scannedQty: 0, scanned: 0 }))
    return v
  }
  for (const r of ledger) spotOf(r).book = round3(Number(r.qty))
  for (const p of packages) {
    const s = spotOf(p)
    s.inPackages = round3(s.inPackages + Number(p.qty))
    s.packages++
    if (found.has(p.id)) {
      s.scannedQty = round3(s.scannedQty + Number(p.qty))
      s.scanned++
    }
  }
  for (const k of Object.keys(loose)) {
    const [itemId, ownership, owner] = k.split('|')
    spotOf({ itemId, ownership: ownership as Ownership, ownerCustomerId: owner || null })
  }

  const ids = [...new Set([...spots.values()].map((s) => s.itemId))]
  const owners = [...new Set([...spots.values()].map((s) => s.ownerCustomerId).filter((x): x is string => !!x))]
  const [items, customers] = await Promise.all([
    db.item.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, categoryId: true, uom: { select: { symbol: true } } } }),
    owners.length ? db.customer.findMany({ where: { id: { in: owners } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ])
  const itemOf = new Map(items.map((i) => [i.id, i]))
  const customerOf = new Map(customers.map((x) => [x.id, x.name]))

  const lines = [...spots.entries()]
    .map(([key, s]) => {
      const it = itemOf.get(s.itemId)
      const looseBook = round3(s.book - s.inPackages)
      const looseCounted = key in loose ? loose[key] : null
      // In the count: an item with stickers here (the whole store), or one
      // touched — a sticker scanned or a figure counted by hand.
      const inCount = scope === 'STORE' ? s.packages > 0 || s.scanned > 0 || looseCounted != null : s.scanned > 0 || looseCounted != null
      // Stock without stickers that nobody counted is taken as it stands.
      const countedQty = round3(s.scannedQty + (looseCounted ?? Math.max(0, looseBook)))
      return {
        key,
        itemId: s.itemId,
        code: it?.code ?? '',
        name: it?.name ?? 'Unknown item',
        unit: it?.uom?.symbol ?? '',
        tracked: it ? ruleOf(it.categoryId).tracked : false,
        ownership: s.ownership,
        ownerCustomerId: s.ownerCustomerId,
        owner: s.ownerCustomerId ? (customerOf.get(s.ownerCustomerId) ?? 'Customer') : null,
        book: s.book,
        packages: s.packages,
        inPackages: s.inPackages,
        scanned: s.scanned,
        scannedQty: s.scannedQty,
        looseBook,
        looseCounted,
        inCount,
        countedQty,
        difference: inCount ? round3(countedQty - s.book) : 0,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || (a.owner ?? '').localeCompare(b.owner ?? ''))

  const counted = new Set(lines.filter((l) => l.inCount).map((l) => l.key))
  const stillToFind = packages
    .filter((p) => !found.has(p.id) && counted.has(spotKey(p)))
    .map((p) => {
      const it = itemOf.get(p.itemId)
      return { id: p.id, code: p.code, itemId: p.itemId, item: it?.name ?? '', unit: it?.uom?.symbol ?? '', qty: Number(p.qty), packType: p.packType, lotNo: p.lotNo }
    })
  const shaped = scans.map((s) => shapeScan(s, c.warehouseId))
  return {
    lines,
    stillToFind,
    scans: shaped,
    problems: shaped.filter((s) => s.result !== 'FOUND'),
    totals: {
      expected: packages.filter((p) => counted.has(spotKey(p)) || scope === 'STORE').length,
      found: found.size,
      toFind: stillToFind.length,
      scans: scans.length,
      problems: shaped.filter((s) => s.result !== 'FOUND').length,
      differences: lines.filter((l) => l.inCount && l.difference !== 0).length,
      handCounted: lines.filter((l) => l.looseCounted != null).length,
    },
  }
}

/** A count to show: the live review while it is open; once finished, its adjustment and what was withdrawn. */
export async function countView(id: string) {
  const c = await prisma.stockCount.findUnique({
    where: { id },
    include: {
      warehouse: { select: { id: true, name: true } },
      startedBy: { select: { name: true } },
      adjustment: {
        select: {
          id: true,
          adjustmentNumber: true,
          status: true,
          rejectReason: true,
          approvedAt: true,
          approvedBy: { select: { name: true } },
          lines: { select: { itemId: true, bookQty: true, countedQty: true, difference: true, item: { select: { code: true, name: true, uom: { select: { symbol: true } } } }, ownerCustomer: { select: { name: true } } } },
        },
      },
    },
  })
  if (!c) throw new AppError('That stock count does not exist', 404, 'NOT_FOUND')
  const head = {
    id: c.id,
    countNumber: c.countNumber,
    status: c.status,
    warehouse: c.warehouse,
    notes: c.notes,
    startedAt: c.startedAt,
    startedBy: c.startedBy?.name ?? null,
    submittedAt: c.submittedAt,
    closedAt: c.closedAt,
    cancelReason: c.cancelReason,
  }
  if (c.status === 'OPEN') {
    const [store, scanned] = await Promise.all([reviewOf(prisma, c, 'STORE'), reviewOf(prisma, c, 'SCANNED')])
    // What finishing would do under each choice, for the screen to set side by side.
    const effect = (r: typeof store) => ({ toFind: r.totals.toFind, differences: r.totals.differences, items: r.lines.filter((l) => l.inCount).length })
    return { ...head, review: store, finish: { STORE: effect(store), SCANNED: effect(scanned) } }
  }
  const ids = Array.isArray(c.missing) ? (c.missing as string[]) : []
  const [missing, scans] = await Promise.all([
    ids.length
      ? prisma.stockPackage.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, qty: true, status: true, packType: true, lotNo: true, item: { select: { name: true, uom: { select: { symbol: true } } } } }, orderBy: { code: 'asc' } })
      : Promise.resolve([]),
    prisma.stockCountScan.findMany({ where: { countId: c.id }, orderBy: { scannedAt: 'desc' }, select: scanSelect }),
  ])
  return {
    ...head,
    adjustment: c.adjustment
      ? {
          ...c.adjustment,
          lines: c.adjustment.lines.map((l) => ({
            item: l.item.name,
            code: l.item.code,
            unit: l.item.uom?.symbol ?? '',
            owner: l.ownerCustomer?.name ?? null,
            book: Number(l.bookQty),
            counted: Number(l.countedQty),
            difference: Number(l.difference),
          })),
        }
      : null,
    // Withdrawn once the adjustment was approved; still standing while it waits, or if it was refused.
    missing: missing.map((p) => ({ id: p.id, code: p.code, item: p.item.name, unit: p.item.uom?.symbol ?? '', qty: Number(p.qty), status: p.status, packType: p.packType, lotNo: p.lotNo })),
    scans: scans.map((s) => shapeScan(s, c.warehouseId)),
  }
}

// ── Finishing ──────────────────────────────────────────────────────────────

/** The rate to put on stock found where the book had none: the item's standard rate, else what it carries elsewhere. */
async function rateFor(tx: Prisma.TransactionClient, itemId: string) {
  const it = await tx.item.findUnique({ where: { id: itemId }, select: { standardRate: true } })
  if (it?.standardRate != null && Number(it.standardRate) > 0) return Number(it.standardRate)
  const [row] = await tx.$queryRaw<Array<{ qty: number | null; value: number | null }>>`
    SELECT COALESCE(SUM("inQty" - "outQty"), 0)::float8 AS qty,
           COALESCE(SUM(("inQty" - "outQty") * COALESCE("unitRate", 0)), 0)::float8 AS value
    FROM ld_erp.stock_ledger WHERE "itemId" = ${itemId} AND ownership = 'OWNED'`
  const qty = Number(row?.qty ?? 0)
  return qty > 0 ? Math.round((Number(row?.value ?? 0) / qty) * 100) / 100 : 0
}

/**
 * Finishing: the differences become a stock adjustment, waiting for a store
 * manager like any count. Every item counted is on it, matched or not. The
 * stickers not found are fixed now and withdrawn when it is approved; if
 * nothing differs it is approved as saved, and the count closes at once.
 */
export async function submitCount(tx: Prisma.TransactionClient, countId: string, scope: CountScope, userId: string | null) {
  const c = await lockCount(tx, countId)
  mustBeOpen(c)
  const r = await reviewOf(tx, c, scope)
  const counted = r.lines.filter((l) => l.inCount)
  if (!counted.length) {
    throw new AppError(
      scope === 'SCANNED' ? 'Nothing is counted yet: scan the stickers on the racks, or count the loose stock by hand.' : `Nothing in ${c.warehouse.name} to count: it has no stock with stickers, and nothing was counted by hand.`,
      400,
      'NOTHING_COUNTED',
    )
  }
  const lines = []
  for (const l of counted) {
    const difference = round3(l.countedQty - l.book)
    lines.push({
      itemId: l.itemId,
      ownership: l.ownership,
      ownerCustomerId: l.ownerCustomerId,
      sizeId: null,
      countedQty: Math.max(0, l.countedQty),
      // Found where the book had none: priced, or the adjustment refuses it.
      ...(l.ownership === 'OWNED' && difference > 0 && l.book <= 0 ? { unitRate: await rateFor(tx, l.itemId) } : {}),
    })
  }
  const t = r.totals
  const reason = [
    `Stock count ${c.countNumber} by scanning${scope === 'SCANNED' ? ' (only the items scanned)' : ''}`,
    `${t.found} of ${t.found + t.toFind} stickers found`,
    t.toFind ? `${t.toFind} not found` : null,
    t.handCounted ? `${t.handCounted} ${t.handCounted === 1 ? 'item' : 'items'} counted by hand` : null,
  ]
    .filter(Boolean)
    .join(', ')
  const adjustment = await createAdjustment(tx, { warehouseId: c.warehouseId, reason, lines } as Parameters<typeof createAdjustment>[1], userId)
  await tx.stockAdjustment.update({ where: { id: adjustment.id }, data: { source: 'SCAN_COUNT' } })
  await tx.stockCount.update({
    where: { id: countId },
    data: { status: 'SUBMITTED', submittedAt: new Date(), adjustmentId: adjustment.id, missing: r.stillToFind.map((p) => p.id) },
  })
  // Nothing differed: approved as saved, so the count is settled now.
  const settled = adjustment.status === 'APPROVED' ? await afterCountDecided(tx, adjustment.id, true, userId) : null
  return { count: c, adjustment, review: r, settled }
}

// ── The list ───────────────────────────────────────────────────────────────

export async function listCounts(q: { status?: string; warehouseId?: string; q?: string; page: number; limit: number }) {
  const where: Prisma.StockCountWhereInput = {
    ...(q.status && ['OPEN', 'SUBMITTED', 'CLOSED', 'CANCELLED'].includes(q.status) ? { status: q.status } : {}),
    ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}),
    ...(q.q ? { OR: [{ countNumber: { contains: q.q, mode: 'insensitive' } }, { warehouse: { name: { contains: q.q, mode: 'insensitive' } } }] } : {}),
  }
  const [rows, total] = await Promise.all([
    prisma.stockCount.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      select: {
        id: true,
        countNumber: true,
        status: true,
        startedAt: true,
        submittedAt: true,
        closedAt: true,
        missing: true,
        warehouse: { select: { id: true, name: true } },
        startedBy: { select: { name: true } },
        adjustment: { select: { adjustmentNumber: true, status: true } },
      },
    }),
    prisma.stockCount.count({ where }),
  ])
  const tallies = rows.length
    ? await prisma.stockCountScan.groupBy({ by: ['countId', 'result'], where: { countId: { in: rows.map((r) => r.id) } }, _count: { _all: true } })
    : []
  const tally = (id: string, result?: string) => tallies.filter((t) => t.countId === id && (!result || t.result === result)).reduce((s, t) => s + t._count._all, 0)
  return {
    rows: rows.map((r) => ({
      id: r.id,
      countNumber: r.countNumber,
      status: r.status,
      store: r.warehouse.name,
      warehouseId: r.warehouse.id,
      startedAt: r.startedAt,
      startedBy: r.startedBy?.name ?? null,
      submittedAt: r.submittedAt,
      closedAt: r.closedAt,
      scans: tally(r.id),
      found: tally(r.id, 'FOUND'),
      notFound: Array.isArray(r.missing) ? r.missing.length : null,
      adjustment: r.adjustment,
    })),
    total,
  }
}
