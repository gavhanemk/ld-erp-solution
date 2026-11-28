/**
 * The reconciliation snapshot: every figure a change must leave alone, read
 * out of the database and kept in one file, so a migration or a new feature
 * can be signed off as "nothing moved that should not have".
 *
 * Read-only: it runs nothing but SELECTs.
 *
 *   take <file>        write a snapshot of the database DATABASE_URL points at
 *   compare <a> <b>    list every difference between two snapshots, and the
 *                      integrity checks of the second
 *
 * From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   npx tsx ../../tools/reconcile-snapshot.ts take C:/path/before.json
 *
 * What it holds:
 *   - stock: quantity and value of every balance (item, store, owner, size,
 *     grade), as the stock ledger adds them up;
 *   - stock checks: balances below zero, value left on nothing, stickers,
 *     garment tags or sealed cartons claiming more than the ledger holds,
 *     holds larger than the stock they hold;
 *   - accounts: every ledger's debits and credits on posted vouchers, by
 *     brand tag too (the P&L by brand reads exactly this), and any voucher
 *     that does not balance;
 *   - counts of the documents a change could add or lose;
 *   - what brand stock (phase 5) must carry through untouched: every active
 *     hold, garment tags by store, status and owner, stickers by lot (roll
 *     and batch traceability), batch numbers on the ledger, and each month's
 *     stock movements with their values (historical valuation). Once stock
 *     carries a brand, each brand's share of every balance as well; the
 *     balances above stay keyed without it, so a migration and every earmark
 *     can be shown to leave the company's stock exactly as it was.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { prisma } from '../packages/database/src/index'

type Num = number
interface Snapshot {
  takenAt: string
  database: string
  stock: Record<string, { qty: Num; value: Num }>
  checks: {
    negative: string[]
    valueWithoutQty: string[]
    stickersOver: string[]
    tagsOver: string[]
    cartonsOver: string[]
    holdsOver: string[]
  }
  accounts: {
    ledgers: Record<string, { debit: Num; credit: Num }>
    byTag: Record<string, { debit: Num; credit: Num }>
    unbalanced: string[]
    totals: { debit: Num; credit: Num }
  }
  counts: Record<string, Num>
  /** Phase 5's guard rails; absent from snapshots taken before they were added. */
  holds?: Record<string, { qty: Num; lines: Num }>
  garments?: Record<string, { count: Num }>
  lots?: Record<string, { stickers: Num; qty: Num }>
  batches?: Record<string, { qty: Num }>
  history?: Record<string, { rows: Num; inQty: Num; outQty: Num; inValue: Num; outValue: Num }>
  brandShares?: Record<string, { qty: Num; value: Num }>
}

const r3 = (n: unknown) => Math.round(Number(n ?? 0) * 1000) / 1000
const r2 = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100

async function take(): Promise<Snapshot> {
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`

  // Every balance, exactly as the stock writer keys it.
  const balances = await prisma.$queryRaw<
    Array<{ itemId: string; warehouseId: string; ownership: string; owner: string | null; sizeId: string | null; grade: string; qty: number; value: number }>
  >`
    SELECT "itemId", "warehouseId", ownership::text AS ownership, "ownerCustomerId" AS owner, "sizeId", grade,
           SUM("inQty" - "outQty")::float8 AS qty,
           SUM(("inQty" - "outQty") * COALESCE("unitRate", 0))::float8 AS value
    FROM ld_erp.stock_ledger
    GROUP BY "itemId", "warehouseId", ownership, "ownerCustomerId", "sizeId", grade`
  const stock: Snapshot['stock'] = {}
  const negative: string[] = []
  const valueWithoutQty: string[] = []
  for (const b of balances) {
    const key = [b.itemId, b.warehouseId, b.ownership, b.owner ?? '', b.sizeId ?? '', b.grade].join('|')
    const qty = r3(b.qty)
    const value = r2(b.value)
    if (qty === 0 && value === 0) continue
    stock[key] = { qty, value }
    if (qty < 0) negative.push(`${key} qty ${qty}`)
    if (qty === 0 && Math.abs(value) >= 0.01) valueWithoutQty.push(`${key} value ${value}`)
  }

  // Stickers are part of ledger stock, never extra: per item, store and owner
  // (all grades together, as a roll's grade can change in place).
  const stickersOver = (
    await prisma.$queryRaw<Array<{ k: string; tagged: number; book: number }>>`
      WITH p AS (
        SELECT "itemId", "warehouseId", ownership::text AS o, COALESCE("ownerCustomerId", '') AS c, COALESCE("brandId", '') AS b, SUM(qty)::float8 AS tagged
        FROM ld_erp.stock_packages WHERE status::text = 'IN_STOCK' GROUP BY 1, 2, 3, 4, 5),
      l AS (
        SELECT "itemId", "warehouseId", ownership::text AS o, COALESCE("ownerCustomerId", '') AS c, COALESCE("brandId", '') AS b, SUM("inQty" - "outQty")::float8 AS book
        FROM ld_erp.stock_ledger GROUP BY 1, 2, 3, 4, 5)
      SELECT p."itemId" || '|' || p."warehouseId" || '|' || p.o || '|' || p.c || '|' || p.b AS k, p.tagged, COALESCE(l.book, 0) AS book
      FROM p LEFT JOIN l USING ("itemId", "warehouseId", o, c, b)
      WHERE p.tagged > COALESCE(l.book, 0) + 0.0005`
  ).map((x) => `${x.k} stickers ${r3(x.tagged)} > book ${r3(x.book)}`)

  // Garment tags in the store, per item, store, size, grade and owner.
  const tagsOver = (
    await prisma.$queryRaw<Array<{ k: string; tagged: number; book: number }>>`
      WITH g AS (
        SELECT "itemId", "warehouseId", COALESCE("sizeId", '') AS s, grade, ownership::text AS o, COALESCE("ownerCustomerId", '') AS c, COALESCE("brandId", '') AS b, COUNT(*)::float8 AS tagged
        FROM ld_erp.garments WHERE status::text IN ('IN_STOCK', 'PACKED') GROUP BY 1, 2, 3, 4, 5, 6, 7),
      l AS (
        SELECT "itemId", "warehouseId", COALESCE("sizeId", '') AS s, grade, ownership::text AS o, COALESCE("ownerCustomerId", '') AS c, COALESCE("brandId", '') AS b, SUM("inQty" - "outQty")::float8 AS book
        FROM ld_erp.stock_ledger GROUP BY 1, 2, 3, 4, 5, 6, 7)
      SELECT g."itemId" || '|' || g."warehouseId" || '|' || g.s || '|' || g.grade || '|' || g.o || '|' || g.b AS k, g.tagged, COALESCE(l.book, 0) AS book
      FROM g LEFT JOIN l USING ("itemId", "warehouseId", s, grade, o, c, b)
      WHERE g.tagged > COALESCE(l.book, 0) + 0.0005`
  ).map((x) => `${x.k} tags ${x.tagged} > book ${r3(x.book)}`)

  // Pieces sealed in cartons still in the store.
  const cartonsOver = (
    await prisma.$queryRaw<Array<{ k: string; sealed: number; book: number }>>`
      WITH c AS (
        SELECT l."itemId", c."warehouseId", l."sizeId" AS s, l.grade, COALESCE(c."brandId", '') AS b, SUM(l.qty)::float8 AS sealed
        FROM ld_erp.fg_carton_lines l JOIN ld_erp.fg_cartons c ON c.id = l."cartonId"
        WHERE c.status::text = 'PACKED' GROUP BY 1, 2, 3, 4, 5),
      l AS (
        SELECT "itemId", "warehouseId", "sizeId" AS s, grade, COALESCE("brandId", '') AS b, SUM("inQty" - "outQty")::float8 AS book
        FROM ld_erp.stock_ledger WHERE ownership::text = 'OWNED' GROUP BY 1, 2, 3, 4, 5)
      SELECT c."itemId" || '|' || c."warehouseId" || '|' || c.s || '|' || c.grade || '|' || c.b AS k, c.sealed, COALESCE(l.book, 0) AS book
      FROM c LEFT JOIN l USING ("itemId", "warehouseId", s, grade, b)
      WHERE c.sealed > COALESCE(l.book, 0) + 0.0005`
  ).map((x) => `${x.k} sealed ${x.sealed} > book ${r3(x.book)}`)

  // Holds never promise more than the store has of our own usable stock.
  const holdsOver = (
    await prisma.$queryRaw<Array<{ k: string; held: number; book: number }>>`
      WITH h AS (
        SELECT "itemId", "warehouseId", SUM(qty)::float8 AS held
        FROM ld_erp.stock_reservations WHERE status::text = 'ACTIVE' GROUP BY 1, 2),
      l AS (
        SELECT "itemId", "warehouseId", SUM("inQty" - "outQty")::float8 AS book
        FROM ld_erp.stock_ledger WHERE ownership::text = 'OWNED' AND grade = 'A' AND "sizeId" IS NULL GROUP BY 1, 2)
      SELECT h."itemId" || '|' || h."warehouseId" AS k, h.held, COALESCE(l.book, 0) AS book
      FROM h LEFT JOIN l USING ("itemId", "warehouseId")
      WHERE h.held > COALESCE(l.book, 0) + 0.0005`
  ).map((x) => `${x.k} held ${r3(x.held)} > book ${r3(x.book)}`)

  // The books: posted vouchers only, as every report counts them.
  const lines = await prisma.$queryRaw<Array<{ ledgerId: string; tag: string | null; debit: number; credit: number }>>`
    SELECT l."ledgerId", l."costCentreId" AS tag, SUM(l.debit)::float8 AS debit, SUM(l.credit)::float8 AS credit
    FROM ld_erp.acc_voucher_lines l JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
    WHERE v.status::text = 'POSTED'
    GROUP BY l."ledgerId", l."costCentreId"`
  const ledgers: Snapshot['accounts']['ledgers'] = {}
  const byTag: Snapshot['accounts']['byTag'] = {}
  let td = 0
  let tc = 0
  for (const l of lines) {
    const d = r2(l.debit)
    const c = r2(l.credit)
    const led = (ledgers[l.ledgerId] ??= { debit: 0, credit: 0 })
    led.debit = r2(led.debit + d)
    led.credit = r2(led.credit + c)
    byTag[`${l.ledgerId}|${l.tag ?? ''}`] = { debit: d, credit: c }
    td += d
    tc += c
  }
  const unbalanced = (
    await prisma.$queryRaw<Array<{ no: string; debit: number; credit: number }>>`
      SELECT v."voucherNo" AS no, COALESCE(SUM(l.debit), 0)::float8 AS debit, COALESCE(SUM(l.credit), 0)::float8 AS credit
      FROM ld_erp.acc_vouchers v LEFT JOIN ld_erp.acc_voucher_lines l ON l."voucherId" = v.id
      GROUP BY v.id, v."voucherNo"
      HAVING COALESCE(SUM(l.debit), 0) <> COALESCE(SUM(l.credit), 0)`
  ).map((x) => `${x.no} debit ${r2(x.debit)} credit ${r2(x.credit)}`)

  const counts: Record<string, number> = {
    salesOrders: await prisma.salesOrder.count(),
    quotations: await prisma.salesQuotation.count(),
    manufacturingOrders: await prisma.manufacturingOrder.count(),
    purchaseOrders: await prisma.purchaseOrder.count(),
    grns: await prisma.gRN.count(),
    salesInvoices: await prisma.salesInvoice.count(),
    vouchers: await prisma.voucher.count(),
    voucherLines: await prisma.voucherLine.count(),
    stockRows: await prisma.stockLedger.count(),
    transfers: await prisma.stockTransfer.count(),
    adjustments: await prisma.stockAdjustment.count(),
    jobWorkChallans: await prisma.jobWorkChallan.count(),
    fgReceipts: await prisma.finishedGoodsReceipt.count(),
    reservations: await prisma.stockReservation.count(),
    brands: await prisma.brand.count(),
    departments: await prisma.department.count(),
    warehouses: await prisma.warehouse.count(),
    items: await prisma.item.count(),
    styles: await prisma.style.count(),
  }

  // Every active hold, by what it holds and for whom.
  const holds: NonNullable<Snapshot['holds']> = {}
  for (const h of await prisma.$queryRaw<Array<{ k: string; qty: number; lines: number }>>`
    SELECT "itemId" || '|' || "warehouseId" || '|' || COALESCE("soId", '') || '|' || COALESCE("customerId", '') AS k, SUM(qty)::float8 AS qty, COUNT(*)::int AS lines
    FROM ld_erp.stock_reservations WHERE status::text = 'ACTIVE' GROUP BY 1`)
    holds[h.k] = { qty: r3(h.qty), lines: h.lines }

  // Garment tags: where each one is, in what state, whose.
  const garments: NonNullable<Snapshot['garments']> = {}
  for (const g of await prisma.$queryRaw<Array<{ k: string; count: number }>>`
    SELECT "itemId" || '|' || "warehouseId" || '|' || COALESCE("sizeId", '') || '|' || grade || '|' || ownership::text || '|' || COALESCE("ownerCustomerId", '') || '|' || status::text AS k, COUNT(*)::int AS count
    FROM ld_erp.garments GROUP BY 1`)
    garments[g.k] = { count: g.count }

  // Stickers by lot: rolls and batches keep their numbers wherever they go.
  const lots: NonNullable<Snapshot['lots']> = {}
  for (const p of await prisma.$queryRaw<Array<{ k: string; stickers: number; qty: number }>>`
    SELECT "itemId" || '|' || "warehouseId" || '|' || COALESCE("lotNo", '') || '|' || status::text AS k, COUNT(*)::int AS stickers, SUM(qty)::float8 AS qty
    FROM ld_erp.stock_packages GROUP BY 1`)
    lots[p.k] = { stickers: p.stickers, qty: r3(p.qty) }

  // Batch numbers on the ledger itself.
  const batches: NonNullable<Snapshot['batches']> = {}
  for (const b of await prisma.$queryRaw<Array<{ k: string; qty: number }>>`
    SELECT "itemId" || '|' || "warehouseId" || '|' || "batchNumber" AS k, SUM("inQty" - "outQty")::float8 AS qty
    FROM ld_erp.stock_ledger WHERE "batchNumber" IS NOT NULL GROUP BY 1`) {
    const qty = r3(b.qty)
    if (qty !== 0) batches[b.k] = { qty }
  }

  // Each month's movements and their values: a change that rewrote a past rate shows here.
  const history: NonNullable<Snapshot['history']> = {}
  for (const m of await prisma.$queryRaw<Array<{ m: string; rows: number; inQty: number; outQty: number; inValue: number; outValue: number }>>`
    SELECT to_char("transactionDate" + interval '5 hours 30 minutes', 'YYYY-MM') AS m, COUNT(*)::int AS rows,
           SUM("inQty")::float8 AS "inQty", SUM("outQty")::float8 AS "outQty",
           SUM("inQty" * COALESCE("unitRate", 0))::float8 AS "inValue", SUM("outQty" * COALESCE("unitRate", 0))::float8 AS "outValue"
    FROM ld_erp.stock_ledger GROUP BY 1`)
    history[m.m] = { rows: m.rows, inQty: r3(m.inQty), outQty: r3(m.outQty), inValue: r2(m.inValue), outValue: r2(m.outValue) }

  // Brand shares, once stock carries a brand (phase 5); none before.
  const [{ has }] = await prisma.$queryRaw<{ has: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'ld_erp' AND table_name = 'stock_ledger' AND column_name = 'brandId') AS has`
  let brandShares: Snapshot['brandShares']
  if (has) {
    brandShares = {}
    for (const b of await prisma.$queryRawUnsafe<Array<{ k: string; qty: number; value: number }>>(
      `SELECT "itemId" || '|' || "warehouseId" || '|' || ownership::text || '|' || COALESCE("ownerCustomerId", '') || '|' || COALESCE("sizeId", '') || '|' || grade || '|' || COALESCE("brandId", 'central') AS k,
              SUM("inQty" - "outQty")::float8 AS qty, SUM(("inQty" - "outQty") * COALESCE("unitRate", 0))::float8 AS value
       FROM ld_erp.stock_ledger GROUP BY 1`,
    )) {
      const qty = r3(b.qty)
      const value = r2(b.value)
      if (qty !== 0 || value !== 0) brandShares[b.k] = { qty, value }
    }
  }

  return {
    takenAt: new Date().toISOString(),
    database: db,
    stock,
    checks: { negative, valueWithoutQty, stickersOver, tagsOver, cartonsOver, holdsOver },
    accounts: { ledgers, byTag, unbalanced, totals: { debit: r2(td), credit: r2(tc) } },
    counts,
    holds,
    garments,
    lots,
    batches,
    history,
    ...(brandShares ? { brandShares } : {}),
  }
}

function diffMaps<T extends Record<string, number>>(label: string, a: Record<string, T>, b: Record<string, T>): string[] {
  const out: string[] = []
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k]
    const y = b[k]
    if (!x) out.push(`${label} new      ${k} ${JSON.stringify(y)}`)
    else if (!y) out.push(`${label} gone     ${k} ${JSON.stringify(x)}`)
    else if (Object.keys(x).some((f) => Math.abs(Number(x[f]) - Number(y[f])) > 0.0005)) out.push(`${label} changed  ${k} ${JSON.stringify(x)} → ${JSON.stringify(y)}`)
  }
  return out
}

function compare(a: Snapshot, b: Snapshot): number {
  const differences = [
    ...diffMaps('stock', a.stock, b.stock),
    ...diffMaps('ledger', a.accounts.ledgers, b.accounts.ledgers),
    ...diffMaps('tag', a.accounts.byTag, b.accounts.byTag),
    // Phase 5's guard rails, where both snapshots have them.
    ...(a.holds && b.holds ? diffMaps('hold', a.holds, b.holds) : []),
    ...(a.garments && b.garments ? diffMaps('garment', a.garments, b.garments) : []),
    ...(a.lots && b.lots ? diffMaps('lot', a.lots, b.lots) : []),
    ...(a.batches && b.batches ? diffMaps('batch', a.batches, b.batches) : []),
    ...(a.history && b.history ? diffMaps('month', a.history, b.history) : []),
    ...(a.brandShares && b.brandShares ? diffMaps('share', a.brandShares, b.brandShares) : []),
    ...Object.keys({ ...a.counts, ...b.counts })
      .filter((k) => a.counts[k] !== b.counts[k])
      .map((k) => `count    ${k} ${a.counts[k] ?? '–'} → ${b.counts[k] ?? '–'}`),
  ]
  console.log(`Snapshots: ${a.database} ${a.takenAt}  →  ${b.database} ${b.takenAt}`)
  console.log(differences.length ? differences.join('\n') : 'No differences in stock, books, counts, holds, tags, lots, batches or stock history.')
  const problems = Object.entries(b.checks).flatMap(([k, v]) => v.map((x) => `${k}: ${x}`)).concat(b.accounts.unbalanced.map((x) => `unbalanced: ${x}`))
  if (b.accounts.totals.debit !== b.accounts.totals.credit) problems.push(`books: debits ${b.accounts.totals.debit} ≠ credits ${b.accounts.totals.credit}`)
  console.log(problems.length ? `\nIntegrity problems in the second snapshot:\n${problems.join('\n')}` : '\nIntegrity checks: all clear.')
  return differences.length
}

async function main() {
  const [cmd, x, y] = process.argv.slice(2)
  if (cmd === 'take' && x) {
    const snap = await take()
    writeFileSync(x, JSON.stringify(snap, null, 1))
    const problems = Object.values(snap.checks).reduce((t, v) => t + v.length, 0) + snap.accounts.unbalanced.length
    const n = (o?: object) => Object.keys(o ?? {}).length
    console.log(
      `Snapshot of ${snap.database}: ${n(snap.stock)} balances, ${n(snap.accounts.ledgers)} ledgers, ${n(snap.holds)} holds, ${n(snap.garments)} tag groups, ${n(snap.lots)} lot groups, ${n(snap.batches)} batches, ${n(snap.history)} months${snap.brandShares ? `, ${n(snap.brandShares)} brand shares` : ''}, ${problems} integrity problems → ${x}`,
    )
  } else if (cmd === 'compare' && x && y) {
    const n = compare(JSON.parse(readFileSync(x, 'utf8')), JSON.parse(readFileSync(y, 'utf8')))
    process.exitCode = n ? 1 : 0
  } else {
    console.error('Usage: reconcile-snapshot.ts take <file> | compare <before> <after>')
    process.exitCode = 2
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
