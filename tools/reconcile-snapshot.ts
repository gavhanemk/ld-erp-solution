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
 *   - counts of the documents a change could add or lose.
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
        SELECT "itemId", "warehouseId", ownership::text AS o, COALESCE("ownerCustomerId", '') AS c, SUM(qty)::float8 AS tagged
        FROM ld_erp.stock_packages WHERE status::text = 'IN_STOCK' GROUP BY 1, 2, 3, 4),
      l AS (
        SELECT "itemId", "warehouseId", ownership::text AS o, COALESCE("ownerCustomerId", '') AS c, SUM("inQty" - "outQty")::float8 AS book
        FROM ld_erp.stock_ledger GROUP BY 1, 2, 3, 4)
      SELECT p."itemId" || '|' || p."warehouseId" || '|' || p.o || '|' || p.c AS k, p.tagged, COALESCE(l.book, 0) AS book
      FROM p LEFT JOIN l USING ("itemId", "warehouseId", o, c)
      WHERE p.tagged > COALESCE(l.book, 0) + 0.0005`
  ).map((x) => `${x.k} stickers ${r3(x.tagged)} > book ${r3(x.book)}`)

  // Garment tags in the store, per item, store, size, grade and owner.
  const tagsOver = (
    await prisma.$queryRaw<Array<{ k: string; tagged: number; book: number }>>`
      WITH g AS (
        SELECT "itemId", "warehouseId", COALESCE("sizeId", '') AS s, grade, ownership::text AS o, COALESCE("ownerCustomerId", '') AS c, COUNT(*)::float8 AS tagged
        FROM ld_erp.garments WHERE status::text IN ('IN_STOCK', 'PACKED') GROUP BY 1, 2, 3, 4, 5, 6),
      l AS (
        SELECT "itemId", "warehouseId", COALESCE("sizeId", '') AS s, grade, ownership::text AS o, COALESCE("ownerCustomerId", '') AS c, SUM("inQty" - "outQty")::float8 AS book
        FROM ld_erp.stock_ledger GROUP BY 1, 2, 3, 4, 5, 6)
      SELECT g."itemId" || '|' || g."warehouseId" || '|' || g.s || '|' || g.grade || '|' || g.o AS k, g.tagged, COALESCE(l.book, 0) AS book
      FROM g LEFT JOIN l USING ("itemId", "warehouseId", s, grade, o, c)
      WHERE g.tagged > COALESCE(l.book, 0) + 0.0005`
  ).map((x) => `${x.k} tags ${x.tagged} > book ${r3(x.book)}`)

  // Pieces sealed in cartons still in the store.
  const cartonsOver = (
    await prisma.$queryRaw<Array<{ k: string; sealed: number; book: number }>>`
      WITH c AS (
        SELECT l."itemId", c."warehouseId", l."sizeId" AS s, l.grade, SUM(l.qty)::float8 AS sealed
        FROM ld_erp.fg_carton_lines l JOIN ld_erp.fg_cartons c ON c.id = l."cartonId"
        WHERE c.status::text = 'PACKED' GROUP BY 1, 2, 3, 4),
      l AS (
        SELECT "itemId", "warehouseId", "sizeId" AS s, grade, SUM("inQty" - "outQty")::float8 AS book
        FROM ld_erp.stock_ledger WHERE ownership::text = 'OWNED' GROUP BY 1, 2, 3, 4)
      SELECT c."itemId" || '|' || c."warehouseId" || '|' || c.s || '|' || c.grade AS k, c.sealed, COALESCE(l.book, 0) AS book
      FROM c LEFT JOIN l USING ("itemId", "warehouseId", s, grade)
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

  return {
    takenAt: new Date().toISOString(),
    database: db,
    stock,
    checks: { negative, valueWithoutQty, stickersOver, tagsOver, cartonsOver, holdsOver },
    accounts: { ledgers, byTag, unbalanced, totals: { debit: r2(td), credit: r2(tc) } },
    counts,
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
    ...Object.keys({ ...a.counts, ...b.counts })
      .filter((k) => a.counts[k] !== b.counts[k])
      .map((k) => `count    ${k} ${a.counts[k] ?? '–'} → ${b.counts[k] ?? '–'}`),
  ]
  console.log(`Snapshots: ${a.database} ${a.takenAt}  →  ${b.database} ${b.takenAt}`)
  console.log(differences.length ? differences.join('\n') : 'No differences in stock, books or counts.')
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
    console.log(`Snapshot of ${snap.database}: ${Object.keys(snap.stock).length} balances, ${Object.keys(snap.accounts.ledgers).length} ledgers, ${problems} integrity problems → ${x}`)
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
