import ExcelJS from 'exceljs'
import { prisma } from '@ld-erp/database'
import type { Prisma } from '@prisma/client'
import { AppError } from '../../middleware/errorHandler'
import { addDropdowns, addHowToSheet, addTemplateSheet, readSheetRows, type SheetColumn } from '../../lib/sheet'
import { booksSettings, dayValue, istDay, r2 } from './books.service'

/**
 * The old books into the new: the trial balance on the day before the books
 * start, and the bills still unpaid that day.
 *
 * Both come in from a spreadsheet, are checked row by row, and go in whole or
 * not at all — the same as the other imports. Bringing them in again replaces
 * what the sheet names and leaves everything else alone.
 *
 * A party's unpaid bills decide its opening balance, as in Tally: the
 * customer owed on three old invoices opens owing their total. Old bills are
 * settled from an Accounts Receipt or Payment, since Sales and Purchase never
 * raised them.
 */

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma
const MAX_ROWS = 3000

const money = (v: string | undefined): number | null => {
  if (!v || !v.trim()) return null
  const n = Number(v.replace(/[₹,\s]/g, ''))
  return Number.isFinite(n) ? r2(n) : NaN
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** A date as Excel stored it or as typed: 2026-03-15, 15/03/2026, 15-03-2026, 15-Mar-2026. */
function dateOf(v: string | undefined): string | null | 'bad' {
  const t = (v ?? '').trim()
  if (!t) return null
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (m) return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1])
  m = t.match(/^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{2,4})$/)
  if (m && MONTHS.includes(m[2].toLowerCase())) return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1])
  return 'bad'
}
function ymd(y: number, mo: number, d: number): string | 'bad' {
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return 'bad'
  return dt.toISOString().slice(0, 10)
}

async function mustBeOpen(tx: Tx | typeof prisma) {
  const s = await booksSettings(tx as Tx)
  if (!s.booksStart) throw new AppError('Set the day the books start (Chart of Accounts → Books) first: opening balances are as at that day.', 409, 'BOOKS_NOT_STARTED')
  if (s.lockedUpTo && s.lockedUpTo >= s.booksStart) {
    throw new AppError(`The books are closed up to ${s.lockedUpTo}, which includes the opening balances.`, 409, 'PERIOD_LOCKED')
  }
  return s
}

/** A problem as a sentence, so two of them on one row read apart. */
const sentence = (p: string) => (/[.!?]$/.test(p) ? p : `${p}.`)

/** Signed opening as the sheet shows it: one figure, on one side. */
const sideOf = (n: number) => (n > 0 ? { debit: n, credit: '' } : n < 0 ? { debit: '', credit: -n } : { debit: '', credit: '' })

// ═══════════════════════════════════════════
// THE TRIAL BALANCE
// ═══════════════════════════════════════════

type BalanceKey = 'ledger' | 'group' | 'debit' | 'credit'
const BALANCE_COLUMNS: SheetColumn<BalanceKey>[] = [
  { key: 'ledger', head: 'Ledger*', width: 42, list: 'ledgers', note: 'The ledger as it is named here, or a new one.' },
  { key: 'group', head: 'Group (for a new ledger)', width: 30, list: 'groups', note: 'Only for a ledger not in the list yet.' },
  { key: 'debit', head: 'Debit', width: 16 },
  { key: 'credit', head: 'Credit', width: 16 },
]

export async function balancesTemplate(withCurrent: boolean): Promise<Buffer> {
  const [ledgers, groups] = await Promise.all([
    prisma.ledger.findMany({ orderBy: { name: 'asc' }, select: { name: true, openingBalance: true, group: { select: { name: true } } } }),
    prisma.ledgerGroup.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { name: true } }),
  ])
  const wb = new ExcelJS.Workbook()
  const sheet = addTemplateSheet(wb, 'Opening Balances', BALANCE_COLUMNS)
  if (withCurrent) {
    for (const l of ledgers) sheet.addRow({ ledger: l.name, group: l.group.name, ...sideOf(Number(l.openingBalance)) })
  }
  addDropdowns(wb, sheet, BALANCE_COLUMNS, { ledgers: ledgers.map((l) => l.name), groups: groups.map((g) => g.name) }, Math.max(500, ledgers.length + 200))
  addHowToSheet(wb, [
    'Copy in the trial balance of the old books as it stood on the day before the books start here.',
    'One row per ledger, its balance in Debit or Credit, never both. Income and expense ledgers carry this year\'s figures to that day, so the year\'s profit comes out whole.',
    'Pick a ledger from the list, or type a new name and give it a group: it is made for you.',
    'Customers, suppliers and brokers can be left out here and brought in with their unpaid bills instead; the bills set their balance.',
    'A ledger not on the sheet keeps the opening balance it has. Bringing the sheet in again replaces what it names.',
    'Debits and credits should agree. If they do not, the trial balance shows the difference on its own line until it is put right.',
  ])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export async function planBalances(db: Db, file: Buffer, fileName: string) {
  const rows = await readSheetRows(file, fileName, { columns: BALANCE_COLUMNS, sheetName: 'Opening Balances', mustHave: 'ledger', mustHaveLabel: 'Ledger', maxRows: MAX_ROWS })
  const [ledgers, groups] = await Promise.all([
    db.ledger.findMany({ select: { id: true, name: true, openingBalance: true, billWise: true, group: { select: { name: true } } } }),
    db.ledgerGroup.findMany({ select: { id: true, name: true } }),
  ])
  const byName = new Map(ledgers.map((l) => [l.name.toLowerCase(), l]))
  const groupByName = new Map(groups.map((g) => [g.name.toLowerCase(), g]))
  const seen = new Set<string>()
  const plans = rows.map(({ row, raw }) => {
    const problems: string[] = []
    const name = (raw.ledger ?? '').trim()
    const found = byName.get(name.toLowerCase())
    const group = raw.group?.trim() ? groupByName.get(raw.group.trim().toLowerCase()) : undefined
    if (!name) problems.push('No ledger named')
    else if (seen.has(name.toLowerCase())) problems.push('This ledger is on the sheet twice')
    seen.add(name.toLowerCase())
    if (name && !found && !group) problems.push(raw.group?.trim() ? `There is no group called ${raw.group.trim()}` : `There is no ledger called ${name}: give a group to make it`)
    const dr = money(raw.debit)
    const cr = money(raw.credit)
    if (Number.isNaN(dr) || Number.isNaN(cr)) problems.push('An amount is not a number')
    if ((dr ?? 0) < 0 || (cr ?? 0) < 0) problems.push('Put a figure on its own side rather than below zero')
    if ((dr ?? 0) > 0 && (cr ?? 0) > 0) problems.push('A balance is a debit or a credit, not both')
    const after = r2((dr && !Number.isNaN(dr) ? dr : 0) - (cr && !Number.isNaN(cr) ? cr : 0))
    return {
      row,
      ledger: found?.name ?? name,
      ledgerId: found?.id ?? null,
      groupId: found ? null : group?.id ?? null,
      group: found?.group.name ?? group?.name ?? raw.group?.trim() ?? '',
      action: (found ? 'set' : 'new') as 'set' | 'new',
      before: found ? Number(found.openingBalance) : 0,
      after,
      skipped: false,
      problems: problems.map(sentence),
    }
  })
  const ok = plans.filter((p) => !p.problems.length)
  const debit = r2(ok.reduce((t, p) => t + Math.max(p.after, 0), 0))
  const credit = r2(ok.reduce((t, p) => t + Math.max(-p.after, 0), 0))
  const changes = ok.filter((p) => p.action === 'new' || p.after !== p.before)
  return {
    plans,
    summary: {
      rows: plans.length,
      changes: changes.filter((p) => p.action === 'set').length,
      newLedgers: changes.filter((p) => p.action === 'new').length,
      debit,
      credit,
      difference: r2(debit - credit),
      skipped: 0,
      problems: plans.filter((p) => p.problems.length).length,
    },
  }
}

/** Inside the caller's transaction: all of it, or none. */
export async function runBalances(tx: Tx, file: Buffer, fileName: string) {
  const { plans, summary } = await planBalances(tx, file, fileName)
  if (summary.problems) throw new AppError('Some rows have problems. Fix them and bring the sheet in again.', 400, 'SHEET_PROBLEMS')
  await mustBeOpen(tx)
  const done: Array<{ name: string; code?: string }> = []
  for (const p of plans) {
    if (p.action === 'new') {
      await tx.ledger.create({ data: { name: p.ledger, groupId: p.groupId!, openingBalance: p.after } })
      done.push({ name: `${p.ledger} (new)` })
    } else if (p.after !== p.before) {
      await tx.ledger.update({ where: { id: p.ledgerId! }, data: { openingBalance: p.after } })
      done.push({ name: p.ledger })
    }
  }
  return { created: done, summary }
}

// ═══════════════════════════════════════════
// UNPAID BILLS
// ═══════════════════════════════════════════

type BillKey = 'party' | 'billNo' | 'billDate' | 'dueDate' | 'amount' | 'type'
const BILL_COLUMNS: SheetColumn<BillKey>[] = [
  { key: 'party', head: 'Party*', width: 40, list: 'parties', note: 'The customer, supplier or broker, as its ledger is named, or its code.' },
  { key: 'billNo', head: 'Bill no*', width: 18 },
  { key: 'billDate', head: 'Bill date*', width: 14, note: 'Before the day the books start. 15-03-2026 or a date cell.' },
  { key: 'dueDate', head: 'Due date', width: 14 },
  { key: 'amount', head: 'Amount still unpaid*', width: 18 },
  { key: 'type', head: 'Bill or advance', width: 16, list: 'types', note: 'Bill: they owe it (a customer) or we owe it (a supplier). Advance: paid ahead the other way.' },
]

async function billParties(db: Tx | typeof prisma) {
  const groups = await db.ledgerGroup.findMany({ select: { id: true, parentId: true, systemKey: true, nature: true } })
  const ledgers = await db.ledger.findMany({
    where: { billWise: true },
    select: {
      id: true,
      name: true,
      openingBalance: true,
      groupId: true,
      customer: { select: { code: true } },
      supplier: { select: { code: true } },
      broker: { select: { code: true } },
    },
    orderBy: { name: 'asc' },
  })
  const nature = new Map(groups.map((g) => [g.id, g.nature]))
  return ledgers.map((l) => ({
    ...l,
    code: (l.customer ?? l.supplier ?? l.broker)?.code ?? null,
    /** Owed to us: an asset. A bill on it is a debit. */
    usual: nature.get(l.groupId) === 'ASSET' ? 1 : -1,
  }))
}

export async function billsTemplate(withCurrent: boolean): Promise<Buffer> {
  const parties = await billParties(prisma)
  const wb = new ExcelJS.Workbook()
  const sheet = addTemplateSheet(wb, 'Unpaid Bills', BILL_COLUMNS)
  if (withCurrent) {
    const refs = await prisma.billRef.findMany({ where: { lineId: null }, orderBy: [{ billDate: 'asc' }], select: { ledgerId: true, billNo: true, billDate: true, dueDate: true, amount: true } })
    const byId = new Map(parties.map((p) => [p.id, p]))
    for (const r of refs) {
      const p = byId.get(r.ledgerId)
      if (!p) continue
      const signed = Number(r.amount) * p.usual
      sheet.addRow({ party: p.name, billNo: r.billNo, billDate: istDay(r.billDate), dueDate: r.dueDate ? istDay(r.dueDate) : '', amount: Math.abs(signed), type: signed >= 0 ? 'Bill' : 'Advance' })
    }
  }
  addDropdowns(wb, sheet, BILL_COLUMNS, { parties: parties.map((p) => p.name), types: ['Bill', 'Advance'] }, 2000)
  addHowToSheet(wb, [
    'Every bill still unpaid, in full or in part, on the day before the books start here: customers\' invoices, suppliers\' bills, brokers\' commission.',
    'One row per bill: the party, its number and date, and what is still unpaid on it. A part-paid bill goes in at what is left.',
    'Money a party paid ahead, or that we paid a supplier ahead, is an Advance row, under any reference.',
    'A party\'s rows decide its opening balance: the total of its bills less its advances. Parties not on the sheet keep the balance they have.',
    'Bringing the sheet in again replaces the old bills of every party it names.',
    'These old bills are settled from Accounts: a Receipt for a customer\'s, a Payment for a supplier\'s. New invoices and bills are settled from Sales and Purchase as before.',
  ])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export async function planBills(db: Db, file: Buffer, fileName: string) {
  const rows = await readSheetRows(file, fileName, { columns: BILL_COLUMNS, sheetName: 'Unpaid Bills', mustHave: 'party', mustHaveLabel: 'Party', maxRows: MAX_ROWS })
  const s = await booksSettings(db as Tx)
  const parties = await billParties(db)
  const byName = new Map(parties.map((p) => [p.name.toLowerCase(), p]))
  const byCode = new Map(parties.filter((p) => p.code).map((p) => [p.code!.toLowerCase(), p]))
  const all = await db.ledger.findMany({ select: { name: true, billWise: true } })
  const notBillWise = new Set(all.filter((l) => !l.billWise).map((l) => l.name.toLowerCase()))
  // Bills the documents raised: an old bill may not take one of their numbers.
  const raised = await db.billRef.findMany({ where: { lineId: { not: null }, kind: 'NEW_REF' }, select: { ledgerId: true, billNo: true } })
  const taken = new Set(raised.map((r) => `${r.ledgerId}|${r.billNo.toLowerCase()}`))
  const seen = new Set<string>()
  // An old bill already paid from Accounts cannot be swept away by a new sheet.
  const old = await db.billRef.findMany({ where: { lineId: null, kind: { not: 'AGAINST_REF' } }, select: { ledgerId: true, billNo: true } })
  const settled = old.length
    ? await db.billRef.findMany({
        where: { kind: 'AGAINST_REF', OR: old.map((o) => ({ ledgerId: o.ledgerId, billNo: o.billNo })), line: { voucher: { status: 'POSTED' } } },
        select: { ledgerId: true, billNo: true, line: { select: { voucher: { select: { voucherNo: true } } } } },
      })
    : []
  const paidOn = new Map<string, string>()
  for (const x of settled) if (!paidOn.has(x.ledgerId)) paidOn.set(x.ledgerId, `${x.billNo} (${x.line?.voucher.voucherNo})`)

  const plans = rows.map(({ row, raw }) => {
    const problems: string[] = []
    const typed = (raw.party ?? '').trim()
    const p = byName.get(typed.toLowerCase()) ?? byCode.get(typed.toLowerCase())
    if (!typed) problems.push('No party named')
    else if (!p) problems.push(notBillWise.has(typed.toLowerCase()) ? `${typed} is not kept bill by bill: give its balance on the trial balance sheet instead` : `There is no customer, supplier or broker called ${typed}`)
    if (p && paidOn.has(p.id)) problems.push(`${p.name}'s old bills have money against them already — ${paidOn.get(p.id)} — so they cannot be replaced. Cancel that voucher first.`)
    const billNo = (raw.billNo ?? '').trim()
    if (!billNo) problems.push('No bill number')
    else if (billNo.length > 40) problems.push('A bill number is 40 characters at most')
    if (p && billNo) {
      const key = `${p.id}|${billNo.toLowerCase()}`
      if (seen.has(key)) problems.push(`Bill ${billNo} of ${p.name} is on the sheet twice`)
      if (taken.has(key)) problems.push(`${p.name} already has a bill ${billNo} from this ERP`)
      seen.add(key)
    }
    const billDate = dateOf(raw.billDate)
    const dueDate = dateOf(raw.dueDate)
    if (!billDate) problems.push('No bill date')
    else if (billDate === 'bad') problems.push(`"${raw.billDate}" is not a date`)
    else if (s.booksStart && billDate >= s.booksStart) problems.push(`Dated on or after the books start (${s.booksStart}): it belongs in Sales or Purchase, not among the old bills`)
    if (dueDate === 'bad') problems.push(`"${raw.dueDate}" is not a date`)
    else if (dueDate && billDate && billDate !== 'bad' && dueDate < billDate) problems.push('Due before the bill date')
    const amount = money(raw.amount)
    if (amount === null) problems.push('No amount')
    else if (Number.isNaN(amount) || amount <= 0) problems.push('The amount has to be more than zero')
    const t = (raw.type ?? 'Bill').trim().toLowerCase()
    if (t && t !== 'bill' && t !== 'advance') problems.push('Say Bill or Advance')
    const isAdvance = t === 'advance'
    return {
      row,
      party: p?.name ?? typed,
      ledgerId: p?.id ?? null,
      billNo,
      billDate: billDate && billDate !== 'bad' ? billDate : null,
      dueDate: dueDate && dueDate !== 'bad' ? dueDate : null,
      amount: amount && !Number.isNaN(amount) ? amount : 0,
      type: isAdvance ? ('Advance' as const) : ('Bill' as const),
      /** Signed, debit positive. */
      signed: p && amount && !Number.isNaN(amount) ? r2(amount * p.usual * (isAdvance ? -1 : 1)) : 0,
      skipped: false,
      problems: problems.map(sentence),
    }
  })
  const ok = plans.filter((x) => !x.problems.length)
  // Each named party's opening balance becomes the total of its rows.
  const openings = new Map<string, { name: string; before: number; after: number }>()
  for (const x of ok) {
    const p = parties.find((q) => q.id === x.ledgerId)!
    const o = openings.get(p.id) ?? { name: p.name, before: Number(p.openingBalance), after: 0 }
    o.after = r2(o.after + x.signed)
    openings.set(p.id, o)
  }
  return {
    plans,
    openings,
    summary: {
      rows: plans.length,
      bills: ok.filter((x) => x.type === 'Bill').length,
      advances: ok.filter((x) => x.type === 'Advance').length,
      parties: openings.size,
      changedOpenings: [...openings.values()].filter((o) => o.after !== o.before).length,
      skipped: 0,
      problems: plans.filter((x) => x.problems.length).length,
    },
  }
}

/** Inside the caller's transaction: all of it, or none. */
export async function runBills(tx: Tx, file: Buffer, fileName: string) {
  const { plans, openings, summary } = await planBills(tx, file, fileName)
  if (summary.problems) throw new AppError('Some rows have problems. Fix them and bring the sheet in again.', 400, 'SHEET_PROBLEMS')
  await mustBeOpen(tx)
  const ids = [...openings.keys()]
  await tx.billRef.deleteMany({ where: { lineId: null, ledgerId: { in: ids } } })
  await tx.billRef.createMany({
    data: plans.map((x) => ({
      ledgerId: x.ledgerId!,
      lineId: null,
      kind: x.type === 'Advance' ? ('ADVANCE' as const) : ('NEW_REF' as const),
      billNo: x.billNo,
      billDate: dayValue(x.billDate!),
      dueDate: x.dueDate ? dayValue(x.dueDate) : null,
      amount: x.signed,
    })),
  })
  for (const [id, o] of openings) await tx.ledger.update({ where: { id }, data: { openingBalance: o.after } })
  return { created: [...openings.values()].map((o) => ({ name: `${o.name}: opening ${o.after >= 0 ? 'Dr' : 'Cr'} ${Math.abs(o.after).toFixed(2)}` })), summary }
}

/** Where the opening position stands, for the Opening tab. */
export async function openingSummary() {
  const s = await booksSettings(prisma as unknown as Tx)
  const ledgers = await prisma.ledger.findMany({ where: { openingBalance: { not: 0 } }, select: { id: true, name: true, openingBalance: true, billWise: true } })
  const refs = await prisma.billRef.groupBy({ by: ['ledgerId'], where: { lineId: null }, _sum: { amount: true }, _count: { _all: true } })
  const billSum = new Map(refs.map((r) => [r.ledgerId, Number(r._sum.amount ?? 0)]))
  const debit = r2(ledgers.reduce((t, l) => t + Math.max(Number(l.openingBalance), 0), 0))
  const credit = r2(ledgers.reduce((t, l) => t + Math.max(-Number(l.openingBalance), 0), 0))
  // A party whose old bills do not add up to its opening balance.
  const unsplit = ledgers
    .filter((l) => l.billWise && r2(Number(l.openingBalance) - (billSum.get(l.id) ?? 0)) !== 0)
    .map((l) => ({ name: l.name, opening: Number(l.openingBalance), inBills: r2(billSum.get(l.id) ?? 0) }))
  return {
    booksStart: s.booksStart,
    ledgers: ledgers.length,
    debit,
    credit,
    difference: r2(debit - credit),
    oldBills: refs.reduce((t, r) => t + r._count._all, 0),
    unsplit,
  }
}

