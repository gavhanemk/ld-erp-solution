import type { LedgerNature, Prisma } from '@prisma/client'
import { AppError } from '../../middleware/errorHandler'
import { booksSettings, dayBefore, dayText, dayValue, fyStartOf, ledgerFigures, r2, todayIst, type BooksSettings } from './books.service'

/**
 * The final accounts: profit and loss for a period, the balance sheet on a
 * day, and the stock value both of them turn on.
 *
 * Stock is kept the way an Indian accountant keeps it outside an integrated
 * stock ledger: purchases go to the purchase accounts as they are made, and
 * the goods still on hand are valued at the end of the period. The trading
 * account then reads opening stock + purchases + direct costs − closing stock
 * = cost of what was sold; the balance sheet shows the closing stock as an
 * asset.
 *
 * A day's stock value is, in order:
 *   - before the books start: the stock brought in with the opening trial
 *     balance (the old books' stock at the start of that year);
 *   - a value the accountant set for that very day (a physical count, work in
 *     progress taken in);
 *   - otherwise what inventory holds that day: the mill's own stock, every
 *     movement at its own rate — customers' material left out.
 *
 * Nothing here posts a closing entry. A year's profit is carried into the
 * Profit & Loss A/c as arithmetic, stock included, so the balance sheet
 * agrees on any day of any year.
 */

type Tx = Prisma.TransactionClient

// ═══════════════════════════════════════════
// STOCK
// ═══════════════════════════════════════════

/**
 * What inventory holds at the end of a day: the mill's own stock, at the rate
 * of each movement. Fixed assets are not stock-in-trade: a machine is in the
 * Fixed Assets ledger, not in closing stock.
 */
export async function inventoryValue(tx: Tx, day: string): Promise<number> {
  const rows = await tx.$queryRawUnsafe<Array<{ value: number | null }>>(
    `SELECT COALESCE(SUM((l."inQty" - l."outQty") * COALESCE(l."unitRate", 0)), 0)::float8 AS value
       FROM ld_erp.stock_ledger l
       JOIN ld_erp.items i ON i.id = l."itemId"
      WHERE l.ownership = 'OWNED' AND l."transactionDate" <= $1 AND i.type::text <> 'FIXED_ASSET'`,
    new Date(`${day}T23:59:59.999+05:30`),
  )
  return r2(rows[0]?.value ?? 0)
}

/**
 * The same, share by share (multi-brand phase 6): each brand's earmarked
 * stock, and central stock under '', at the rate of each movement. The
 * shares add up to `inventoryValue` exactly: they are its rows, grouped.
 */
export async function inventoryValueByShare(tx: Tx, day: string): Promise<Map<string, number>> {
  const rows = await tx.$queryRawUnsafe<Array<{ brandId: string | null; value: number | null }>>(
    `SELECT l."brandId", COALESCE(SUM((l."inQty" - l."outQty") * COALESCE(l."unitRate", 0)), 0)::float8 AS value
       FROM ld_erp.stock_ledger l
       JOIN ld_erp.items i ON i.id = l."itemId"
      WHERE l.ownership = 'OWNED' AND l."transactionDate" <= $1 AND i.type::text <> 'FIXED_ASSET'
      GROUP BY l."brandId"`,
    new Date(`${day}T23:59:59.999+05:30`),
  )
  return new Map(rows.map((r) => [r.brandId ?? '', r2(r.value ?? 0)]))
}

/**
 * Stock moved between shares in a period (multi-brand phase 6): earmarks,
 * moves between brands, releases and automatic allocations, by the share it
 * went into and the share it came out of, at the value it moved at. Every
 * move is an out and an in of the same value, so across the shares the two
 * always cancel: a reallocation changes no profit, the company's or the
 * brands' together.
 */
export async function shareTransfers(tx: Tx, from: string, to: string): Promise<Map<string, { in: number; out: number }>> {
  const rows = await tx.$queryRawUnsafe<Array<{ brandId: string | null; inValue: number; outValue: number }>>(
    `SELECT l."brandId",
            COALESCE(SUM(l."inQty" * COALESCE(l."unitRate", 0)), 0)::float8 AS "inValue",
            COALESCE(SUM(l."outQty" * COALESCE(l."unitRate", 0)), 0)::float8 AS "outValue"
       FROM ld_erp.stock_ledger l
       JOIN ld_erp.items i ON i.id = l."itemId"
      WHERE l.ownership = 'OWNED' AND l."referenceType" = 'STOCK_REALLOCATION'
        AND l."transactionDate" >= $1 AND l."transactionDate" <= $2 AND i.type::text <> 'FIXED_ASSET'
      GROUP BY l."brandId"`,
    new Date(`${from}T00:00:00+05:30`),
    new Date(`${to}T23:59:59.999+05:30`),
  )
  return new Map(rows.map((r) => [r.brandId ?? '', { in: r2(r.inValue), out: r2(r.outValue) }]))
}

/** Every group under the Stock-in-Hand group, itself included. */
async function stockGroups(tx: Tx): Promise<Set<string>> {
  const groups = await tx.ledgerGroup.findMany({ select: { id: true, parentId: true, systemKey: true } })
  const ids = new Set(groups.filter((g) => g.systemKey === 'STOCK_IN_HAND').map((g) => g.id))
  for (let grew = true; grew; ) {
    grew = false
    for (const g of groups) if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) ((ids.add(g.id)), (grew = true))
  }
  return ids
}

export interface StockOn {
  day: string
  value: number
  source: 'books' | 'set' | 'inventory'
  /** What inventory says that day, for comparison; null before the books start. */
  inventory: number | null
  set: { value: number; notes: string | null; by: string | null } | null
}

/** The stock value on a day, and where it came from. */
export async function stockOn(tx: Tx, day: string, s: BooksSettings): Promise<StockOn> {
  if (!s.booksStart || day < s.booksStart) {
    const groups = await stockGroups(tx)
    const ledgers = await tx.ledger.findMany({ where: { groupId: { in: [...groups] } }, select: { openingBalance: true } })
    return { day, value: r2(ledgers.reduce((t, l) => t + Number(l.openingBalance), 0)), source: 'books', inventory: null, set: null }
  }
  const [set, inventory] = await Promise.all([
    tx.stockValue.findUnique({ where: { asOn: dayValue(day) }, select: { value: true, notes: true, setBy: { select: { name: true } } } }),
    inventoryValue(tx, day),
  ])
  if (set) return { day, value: Number(set.value), source: 'set', inventory, set: { value: Number(set.value), notes: set.notes, by: set.setBy?.name ?? null } }
  return { day, value: inventory, source: 'inventory', inventory, set: null }
}

/** Sets a day's stock value, or with null hands the day back to inventory. */
export async function setStockValue(tx: Tx, day: string, value: number | null, notes: string | null, userId: string) {
  const s = await booksSettings(tx)
  if (!s.booksStart || day < s.booksStart) {
    throw new AppError('Stock before the books start is the opening stock, brought in with the trial balance.', 400, 'BEFORE_BOOKS')
  }
  if (s.lockedUpTo && day <= s.lockedUpTo) throw new AppError(`The books are closed up to ${dayText(s.lockedUpTo)}; the stock on ${dayText(day)} cannot change.`, 409, 'PERIOD_LOCKED')
  if (day > todayIst()) throw new AppError('Stock cannot be valued for a day still to come.', 400, 'FUTURE_DATE')
  if (value === null) {
    await tx.stockValue.deleteMany({ where: { asOn: dayValue(day) } })
    return null
  }
  const inventory = await inventoryValue(tx, day)
  return tx.stockValue.upsert({
    where: { asOn: dayValue(day) },
    create: { asOn: dayValue(day), value: r2(value), inventoryValue: inventory, notes, setById: userId },
    update: { value: r2(value), inventoryValue: inventory, notes, setById: userId },
  })
}

// ═══════════════════════════════════════════
// PROFIT AND LOSS
// ═══════════════════════════════════════════

type PlKey = 'SALES_ACCOUNTS' | 'DIRECT_INCOMES' | 'PURCHASE_ACCOUNTS' | 'DIRECT_EXPENSES' | 'INDIRECT_INCOMES' | 'INDIRECT_EXPENSES'
const PL_BLOCKS: Array<{ key: PlKey; title: string; income: boolean }> = [
  { key: 'SALES_ACCOUNTS', title: 'Sales', income: true },
  { key: 'DIRECT_INCOMES', title: 'Direct income', income: true },
  { key: 'PURCHASE_ACCOUNTS', title: 'Purchases', income: false },
  { key: 'DIRECT_EXPENSES', title: 'Direct expenses', income: false },
  { key: 'INDIRECT_INCOMES', title: 'Other income', income: true },
  { key: 'INDIRECT_EXPENSES', title: 'Indirect expenses', income: false },
]

/** The standard group at the top of each group's tree. */
async function topKeys(tx: Tx) {
  const groups = await tx.ledgerGroup.findMany({ select: { id: true, parentId: true, systemKey: true, name: true, nature: true, sortOrder: true } })
  const byId = new Map(groups.map((g) => [g.id, g]))
  const top = new Map<string, string | null>()
  for (const g of groups) {
    let t = g
    for (let i = 0; t.parentId && i < 20; i++) t = byId.get(t.parentId) ?? t
    top.set(g.id, t.systemKey)
  }
  return { groups, byId, top }
}

export interface PlLine {
  id: string
  name: string
  group: string
  amount: number
  /** By brand: cost centre id → amount, and '' for what no brand carries. */
  centres: Record<string, number>
  /** By department (cost centre): department id → amount, and '' for what none carries. */
  departments: Record<string, number>
}

export interface PlBlock {
  key: PlKey
  title: string
  total: number
  centres: Record<string, number>
  departments: Record<string, number>
  lines: PlLine[]
}

/**
 * Profit and loss for a period inside one financial year. A period that
 * reaches back to the day the books started is taken from the start of that
 * year, since the old books' figures to that day came in as one sum.
 */
export async function profitAndLoss(tx: Tx, asked: { from: string; to: string }, s: BooksSettings) {
  if (!s.booksStart) throw new AppError('Set the day the books start first.', 409, 'BOOKS_NOT_STARTED')
  const fyStart = fyStartOf(asked.to, s.fyStartMonth)
  let from = asked.from < fyStart ? fyStart : asked.from
  if (s.booksStart >= fyStart && from <= s.booksStart) from = fyStart
  const to = asked.to
  const whole = from === fyStart

  const day0 = new Date(`${from}T00:00:00+05:30`)
  const day1 = new Date(`${to}T23:59:59.999+05:30`)
  const [{ byId, top }, figures, centreRows, deptRows, centres, depts] = await Promise.all([
    topKeys(tx),
    ledgerFigures(tx, { from, to }, s),
    tx.$queryRawUnsafe<Array<{ ledgerId: string; costCentreId: string; amount: number }>>(
      `SELECT l."ledgerId", l."costCentreId", SUM(l.debit - l.credit)::float8 AS amount
         FROM ld_erp.acc_voucher_lines l JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
        WHERE v.status = 'POSTED' AND l."costCentreId" IS NOT NULL AND v.date >= $1 AND v.date <= $2
        GROUP BY l."ledgerId", l."costCentreId"`,
      day0,
      day1,
    ),
    tx.$queryRawUnsafe<Array<{ ledgerId: string; departmentId: string; amount: number }>>(
      `SELECT l."ledgerId", l."departmentId", SUM(l.debit - l.credit)::float8 AS amount
         FROM ld_erp.acc_voucher_lines l JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
        WHERE v.status = 'POSTED' AND l."departmentId" IS NOT NULL AND v.date >= $1 AND v.date <= $2
        GROUP BY l."ledgerId", l."departmentId"`,
      day0,
      day1,
    ),
    tx.costCentre.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, brandId: true, isActive: true, brand: { select: { type: true, isActive: true } } } }),
    tx.department.findMany({ select: { id: true, name: true, parent: { select: { name: true } } } }),
  ])
  const splitOf = (rows: Array<{ ledgerId: string; amount: number }>, key: (r: never) => string) => {
    const out = new Map<string, Map<string, number>>()
    for (const r of rows) {
      const m = out.get(r.ledgerId) ?? new Map<string, number>()
      m.set(key(r as never), r2(r.amount))
      out.set(r.ledgerId, m)
    }
    return out
  }
  const byCentre = splitOf(centreRows, (r: { costCentreId: string }) => r.costCentreId)
  const byDept = splitOf(deptRows, (r: { departmentId: string }) => r.departmentId)

  const blocks = new Map<PlKey, PlBlock>(PL_BLOCKS.map((b) => [b.key, { key: b.key, title: b.title, total: 0, centres: {}, departments: {}, lines: [] }]))
  for (const f of figures) {
    if (f.nature !== 'INCOME' && f.nature !== 'EXPENSE') continue
    const key = top.get(f.groupId) as PlKey | null
    const spec = PL_BLOCKS.find((b) => b.key === key)
    if (!spec) continue
    // Debit positive as the books keep it; turned the right way round for its side.
    const signed = whole ? f.closing : r2(f.dr - f.cr)
    if (signed === 0) continue
    const sign = spec.income ? -1 : 1
    const amount = r2(sign * signed)
    // What each brand and each department carries of it; the rest is '' (not split, no department).
    const spread = (m: Map<string, number> | undefined) => {
      const out: Record<string, number> = {}
      let placed = 0
      for (const [k, a] of m ?? []) {
        out[k] = r2(sign * a)
        placed = r2(placed + out[k])
      }
      out[''] = r2(amount - placed)
      return out
    }
    const split = spread(byCentre.get(f.id))
    const bydept = spread(byDept.get(f.id))
    const block = blocks.get(spec.key)!
    block.lines.push({ id: f.id, name: f.name, group: byId.get(f.groupId)?.name ?? '', amount, centres: split, departments: bydept })
    block.total = r2(block.total + amount)
    for (const [cc, a] of Object.entries(split)) block.centres[cc] = r2((block.centres[cc] ?? 0) + a)
    for (const [d, a] of Object.entries(bydept)) block.departments[d] = r2((block.departments[d] ?? 0) + a)
  }
  for (const b of blocks.values()) b.lines.sort((x, y) => y.amount - x.amount || x.name.localeCompare(y.name))

  const [opening, closing] = await Promise.all([stockOn(tx, dayBefore(from), s), stockOn(tx, to, s)])
  const B = (k: PlKey) => blocks.get(k)!
  const at = (k: PlKey, cc: string) => B(k).centres[cc] ?? 0
  const grossProfit = r2(B('SALES_ACCOUNTS').total + B('DIRECT_INCOMES').total + closing.value - opening.value - B('PURCHASE_ACCOUNTS').total - B('DIRECT_EXPENSES').total)
  const netProfit = r2(grossProfit + B('INDIRECT_INCOMES').total - B('INDIRECT_EXPENSES').total)

  /*
   * By brand (multi-brand phase 6). Each brand's own stock is its share of
   * the balances: its opening and closing stock are its shares' value on the
   * two days, and what moved to it from central stock or another brand, or
   * from it, is set beside them as stock moved in and out — so a brand bears
   * the cost of what it uses and sells, and a reallocation, an out and an in
   * of the same value, makes no profit or loss for anyone. Central stock, and
   * any difference between the books' stock and inventory's (stock brought in
   * with the opening balances, or a value the accountant set), stays with
   * what no brand carries. The columns always add up to the company.
   *
   * A column for each of our own brands in use. A brand switched off, and a
   * customer's brand, shows only when something was booked to it, or its
   * stock stood or moved, in the period: so nothing is hidden, and a brand
   * long retired does not sit there empty.
   */
  const [openShares, closeShares, moved] = await Promise.all([inventoryValueByShare(tx, dayBefore(from)), inventoryValueByShare(tx, to), shareTransfers(tx, from, to)])
  const booked = new Set(centreRows.filter((r) => r.amount !== 0).map((r) => r.costCentreId))
  const stirred = (brandId: string | null) =>
    !!brandId && ((openShares.get(brandId) ?? 0) !== 0 || (closeShares.get(brandId) ?? 0) !== 0 || !!moved.get(brandId)?.in || !!moved.get(brandId)?.out)
  const inUse = (c: (typeof centres)[number]) => c.brand?.type !== 'CUSTOM' && c.isActive !== false && c.brand?.isActive !== false
  const shown = centres.filter((c) => booked.has(c.id) || inUse(c) || stirred(c.brandId))
  const columns = [...shown.map((c) => ({ id: c.id, name: c.name })), { id: '', name: 'Not split' }]
  // A brand's share is shown under its profit centre; one with none (yet) stays with Not split.
  const brandOfCentre = new Map(shown.filter((c) => c.brandId).map((c) => [c.id, c.brandId!]))
  const placed = new Set(brandOfCentre.values())
  const stockFor = (brandId: string) => ({
    opening: openShares.get(brandId) ?? 0,
    closing: closeShares.get(brandId) ?? 0,
    in: moved.get(brandId)?.in ?? 0,
    out: moved.get(brandId)?.out ?? 0,
  })
  const notPlaced = { opening: 0, closing: 0, in: 0, out: 0 }
  for (const k of new Set([...openShares.keys(), ...closeShares.keys(), ...moved.keys()])) {
    if (k !== '' && placed.has(k)) continue
    const f = stockFor(k)
    notPlaced.opening = r2(notPlaced.opening + f.opening)
    notPlaced.closing = r2(notPlaced.closing + f.closing)
    notPlaced.in = r2(notPlaced.in + f.in)
    notPlaced.out = r2(notPlaced.out + f.out)
  }
  const placedOpening = r2([...placed].reduce((t, b) => t + (openShares.get(b) ?? 0), 0))
  const placedClosing = r2([...placed].reduce((t, b) => t + (closeShares.get(b) ?? 0), 0))
  const brand = columns.map((c) => {
    const b = brandOfCentre.get(c.id)
    // Not split: the company's stock less every placed brand's, which is
    // central stock (and inventory's difference from the books' figure).
    const f =
      c.id === ''
        ? { opening: r2(opening.value - placedOpening), closing: r2(closing.value - placedClosing), in: notPlaced.in, out: notPlaced.out }
        : b
          ? stockFor(b)
          : { opening: 0, closing: 0, in: 0, out: 0 }
    const stock = r2(f.closing - f.opening)
    const gross = r2(
      at('SALES_ACCOUNTS', c.id) + at('DIRECT_INCOMES', c.id) + stock - at('PURCHASE_ACCOUNTS', c.id) - f.in + f.out - at('DIRECT_EXPENSES', c.id),
    )
    return {
      id: c.id,
      name: c.name,
      openingStock: f.opening,
      closingStock: f.closing,
      /** Stock moved to this share from central stock or another brand, at the value it moved at. */
      transfersIn: f.in,
      /** Stock moved from this share to another. */
      transfersOut: f.out,
      stockChange: stock,
      grossProfit: gross,
      netProfit: r2(gross + at('INDIRECT_INCOMES', c.id) - at('INDIRECT_EXPENSES', c.id)),
    }
  })

  // By department (cost centre): a column for each department that carries
  // anything in the period, under its parent's name; stock, valued for the
  // mill as a whole, sits with "No department".
  const atD = (k: PlKey, d: string) => B(k).departments[d] ?? 0
  const deptBooked = new Set(deptRows.filter((r) => r.amount !== 0).map((r) => r.departmentId))
  const deptColumns = [
    ...depts
      .filter((d) => deptBooked.has(d.id))
      .map((d) => ({ id: d.id, name: d.name, parent: d.parent?.name ?? null }))
      .sort((a, b) => (a.parent ?? a.name).localeCompare(b.parent ?? b.name) || (a.parent ? 1 : 0) - (b.parent ? 1 : 0) || a.name.localeCompare(b.name)),
    { id: '', name: 'No department', parent: null },
  ]
  const department = deptColumns.map((d) => {
    const stock = d.id === '' ? r2(closing.value - opening.value) : 0
    const gross = r2(atD('SALES_ACCOUNTS', d.id) + atD('DIRECT_INCOMES', d.id) + stock - atD('PURCHASE_ACCOUNTS', d.id) - atD('DIRECT_EXPENSES', d.id))
    return { id: d.id, name: d.name, parent: d.parent, stockChange: stock, grossProfit: gross, netProfit: r2(gross + atD('INDIRECT_INCOMES', d.id) - atD('INDIRECT_EXPENSES', d.id)) }
  })

  return {
    period: { from, to, asked: asked.from !== from ? asked.from : null },
    blocks: PL_BLOCKS.map((b) => B(b.key)),
    openingStock: opening,
    closingStock: closing,
    grossProfit,
    netProfit,
    columns,
    brand,
    deptColumns,
    department,
  }
}

// ═══════════════════════════════════════════
// BALANCE SHEET
// ═══════════════════════════════════════════

export interface BsRow {
  id: string
  name: string
  kind: 'group' | 'ledger' | 'line'
  /** On its own side: a liability as a credit, an asset as a debit. */
  amount: number
  note?: string
  children: BsRow[]
}

/**
 * The balance sheet at the end of a day. Liabilities and capital on one side,
 * assets on the other, each group opening to what is under it. Stock shows at
 * its value that day; this year's profit to the day shows on its own line.
 */
export async function balanceSheet(tx: Tx, asOn: string, s: BooksSettings) {
  if (!s.booksStart) throw new AppError('Set the day the books start first.', 409, 'BOOKS_NOT_STARTED')
  const fyStart = fyStartOf(asOn, s.fyStartMonth)
  const [{ groups, byId }, figures, pl, stockGroupIds] = await Promise.all([
    topKeys(tx),
    ledgerFigures(tx, { from: fyStart, to: asOn }, s),
    profitAndLoss(tx, { from: fyStart, to: asOn }, s),
    stockGroups(tx),
  ])
  const bookStock = r2(figures.filter((f) => stockGroupIds.has(f.groupId)).reduce((t, f) => t + f.closing, 0))
  // The stock gained before this year, which the years' profit carried no record of.
  const earlierStock = r2(pl.openingStock.value - bookStock)

  const isBs = (n: LedgerNature) => n === 'ASSET' || n === 'LIABILITY'
  const kids = new Map<string | null, typeof groups>()
  for (const g of groups) if (isBs(g.nature)) kids.set(g.parentId, [...(kids.get(g.parentId) ?? []), g])
  const ledgersIn = new Map<string, typeof figures>()
  for (const f of figures) if (isBs(f.nature)) ledgersIn.set(f.groupId, [...(ledgersIn.get(f.groupId) ?? []), f])

  /** Signed (debit positive) rows for a group and everything under it. */
  const build = (gid: string): { row: BsRow; signed: number } => {
    const g = byId.get(gid)!
    const rows: BsRow[] = []
    let signed = 0
    if (stockGroupIds.has(gid) && g.systemKey === 'STOCK_IN_HAND') {
      const st = pl.closingStock
      const note = st.source === 'set' ? 'as valued by the accountant' : st.source === 'inventory' ? 'from inventory' : 'brought in with the opening balances'
      return { row: { id: gid, name: g.name, kind: 'group', amount: st.value, note, children: [{ id: 'closing-stock', name: 'Closing stock', kind: 'line', amount: st.value, note, children: [] }] }, signed: st.value }
    }
    for (const c of (kids.get(gid) ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))) {
      const sub = build(c.id)
      if (sub.signed !== 0 || sub.row.children.length) {
        rows.push(sub.row)
        signed = r2(signed + sub.signed)
      }
    }
    for (const f of ledgersIn.get(gid) ?? []) {
      let v = f.closing
      let note: string | undefined
      if (f.systemKey === 'PROFIT_LOSS' && earlierStock !== 0) {
        v = r2(v - earlierStock)
        note = 'with the stock carried from earlier years'
      }
      if (v === 0) continue
      rows.push({ id: f.id, name: f.name, kind: 'ledger', amount: v, note, children: [] })
      signed = r2(signed + v)
    }
    return { row: { id: gid, name: g.name, kind: 'group', amount: signed, children: rows }, signed }
  }

  /** Turns a side's rows the right way round: a liability shown as a credit. */
  const flip = (row: BsRow, sign: number): BsRow => ({ ...row, amount: r2(sign * row.amount), children: row.children.map((c) => flip(c, sign)) })

  const liabilities: BsRow[] = []
  const assets: BsRow[] = []
  let signedTotal = 0
  for (const g of (kids.get(null) ?? []).sort((a, b) => a.sortOrder - b.sortOrder)) {
    const { row, signed } = build(g.id)
    if (signed === 0 && !row.children.length) continue
    signedTotal = r2(signedTotal + signed)
    if (g.nature === 'LIABILITY') liabilities.push(flip(row, -1))
    else assets.push(row)
  }
  // This year's profit to the day, as the profit and loss account works it out.
  liabilities.push({ id: 'profit', name: pl.netProfit >= 0 ? `Profit, ${fyStart} to ${asOn}` : `Loss, ${fyStart} to ${asOn}`, kind: 'line', amount: pl.netProfit, children: [] })
  signedTotal = r2(signedTotal - pl.netProfit)

  const liabilitiesTotal = r2(liabilities.reduce((t, r) => t + r.amount, 0))
  const assetsTotal = r2(assets.reduce((t, r) => t + r.amount, 0))
  return {
    asOn,
    fyStart,
    liabilities,
    assets,
    liabilitiesTotal,
    assetsTotal,
    /** What the opening balances are out by (debit positive); nothing when they agree. */
    openingDifference: signedTotal,
    netProfit: pl.netProfit,
    stock: pl.closingStock,
  }
}
