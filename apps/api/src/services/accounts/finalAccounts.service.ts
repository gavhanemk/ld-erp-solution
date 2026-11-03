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

/** What inventory holds at the end of a day: the mill's own stock, at the rate of each movement. */
export async function inventoryValue(tx: Tx, day: string): Promise<number> {
  const rows = await tx.$queryRawUnsafe<Array<{ value: number | null }>>(
    `SELECT COALESCE(SUM(("inQty" - "outQty") * COALESCE("unitRate", 0)), 0)::float8 AS value
       FROM ld_erp.stock_ledger
      WHERE ownership = 'OWNED' AND "transactionDate" <= $1`,
    new Date(`${day}T23:59:59.999+05:30`),
  )
  return r2(rows[0]?.value ?? 0)
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
}

export interface PlBlock {
  key: PlKey
  title: string
  total: number
  centres: Record<string, number>
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

  const [{ byId, top }, figures, centreRows, centres] = await Promise.all([
    topKeys(tx),
    ledgerFigures(tx, { from, to }, s),
    tx.$queryRawUnsafe<Array<{ ledgerId: string; costCentreId: string; amount: number }>>(
      `SELECT l."ledgerId", l."costCentreId", SUM(l.debit - l.credit)::float8 AS amount
         FROM ld_erp.acc_voucher_lines l JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
        WHERE v.status = 'POSTED' AND l."costCentreId" IS NOT NULL AND v.date >= $1 AND v.date <= $2
        GROUP BY l."ledgerId", l."costCentreId"`,
      new Date(`${from}T00:00:00+05:30`),
      new Date(`${to}T23:59:59.999+05:30`),
    ),
    tx.costCentre.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ])
  const byCentre = new Map<string, Map<string, number>>()
  for (const r of centreRows) {
    const m = byCentre.get(r.ledgerId) ?? new Map<string, number>()
    m.set(r.costCentreId, r2(r.amount))
    byCentre.set(r.ledgerId, m)
  }

  const blocks = new Map<PlKey, PlBlock>(PL_BLOCKS.map((b) => [b.key, { key: b.key, title: b.title, total: 0, centres: {}, lines: [] }]))
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
    const split: Record<string, number> = {}
    let placed = 0
    for (const [cc, a] of byCentre.get(f.id) ?? []) {
      split[cc] = r2(sign * a)
      placed = r2(placed + split[cc])
    }
    split[''] = r2(amount - placed)
    const block = blocks.get(spec.key)!
    block.lines.push({ id: f.id, name: f.name, group: byId.get(f.groupId)?.name ?? '', amount, centres: split })
    block.total = r2(block.total + amount)
    for (const [cc, a] of Object.entries(split)) block.centres[cc] = r2((block.centres[cc] ?? 0) + a)
  }
  for (const b of blocks.values()) b.lines.sort((x, y) => y.amount - x.amount || x.name.localeCompare(y.name))

  const [opening, closing] = await Promise.all([stockOn(tx, dayBefore(from), s), stockOn(tx, to, s)])
  const B = (k: PlKey) => blocks.get(k)!
  const at = (k: PlKey, cc: string) => B(k).centres[cc] ?? 0
  const grossProfit = r2(B('SALES_ACCOUNTS').total + B('DIRECT_INCOMES').total + closing.value - opening.value - B('PURCHASE_ACCOUNTS').total - B('DIRECT_EXPENSES').total)
  const netProfit = r2(grossProfit + B('INDIRECT_INCOMES').total - B('INDIRECT_EXPENSES').total)

  // By brand: stock is valued for the mill as a whole, so its change sits with what no brand carries.
  const columns = [...centres.map((c) => ({ id: c.id, name: c.name })), { id: '', name: 'Not split' }]
  const brand = columns.map((c) => {
    const stock = c.id === '' ? r2(closing.value - opening.value) : 0
    const gross = r2(at('SALES_ACCOUNTS', c.id) + at('DIRECT_INCOMES', c.id) + stock - at('PURCHASE_ACCOUNTS', c.id) - at('DIRECT_EXPENSES', c.id))
    return { id: c.id, name: c.name, stockChange: stock, grossProfit: gross, netProfit: r2(gross + at('INDIRECT_INCOMES', c.id) - at('INDIRECT_EXPENSES', c.id)) }
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
