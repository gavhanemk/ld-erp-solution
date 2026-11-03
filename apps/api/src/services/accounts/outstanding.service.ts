import type { Prisma } from '@prisma/client'
import { booksSettings, dayValue, fyStartOf, istDay, ledgerFigures, r2 } from './books.service'

/**
 * What customers owe and what is owed to suppliers and brokers, bill by bill,
 * from the books: the invoices and bills the documents raised, the unpaid
 * bills brought in from the old books, and every receipt, payment and note
 * set against them. Sales and Purchase each know their own documents; this is
 * the whole picture, old bills included.
 *
 * Each party's bills add up to its ledger balance. Where they do not — an
 * opening balance never split into bills, money on a party kept without bills
 * — the gap shows as its own line, so the total always agrees with the trial
 * balance.
 */

type Tx = Prisma.TransactionClient

export type Side = 'receivable' | 'payable'
type Bucket = 'notDue' | 'd30' | 'd60' | 'd90' | 'over90'
const BUCKETS: Bucket[] = ['notDue', 'd30', 'd60', 'd90', 'over90']

const bucketOf = (days: number): Bucket => (days <= 0 ? 'notDue' : days <= 30 ? 'd30' : days <= 60 ? 'd60' : days <= 90 ? 'd90' : 'over90')
const daysBetween = (from: string, to: string) => Math.round((dayValue(to).getTime() - dayValue(from).getTime()) / 86_400_000)

/** Every group at or under one of these. */
async function groupsUnder(tx: Tx, keys: string[]) {
  const groups = await tx.ledgerGroup.findMany({ select: { id: true, parentId: true, systemKey: true } })
  const ids = new Set(groups.filter((g) => g.systemKey && keys.includes(g.systemKey)).map((g) => g.id))
  for (let grew = true; grew; ) {
    grew = false
    for (const g of groups) if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) ((ids.add(g.id)), (grew = true))
  }
  return ids
}

export interface OutstandingBill {
  billNo: string
  billDate: string
  dueDate: string | null
  /** Days past the due date (or the bill date where there is none); 0 or less is not yet due. */
  days: number
  /** On the party's usual side — owed to us for a customer, owed by us for a supplier. */
  amount: number
  kind: 'bill' | 'advance' | 'unsplit'
  /** The document that raised it, or null for an old bill or one typed in Accounts. */
  raisedBy: string | null
}

export interface OutstandingParty {
  ledgerId: string
  name: string
  partyType: string | null
  partyCode: string | null
  group: string
  bills: OutstandingBill[]
  buckets: Record<Bucket, number>
  /** Bills still owed, on the party's usual side. */
  due: number
  overdue: number
  /** Paid ahead, or credit held: the other way round. */
  advance: number
  /** Due less advance: what the ledger says. */
  net: number
}

/**
 * Outstanding as on a day. Receivable: Sundry Debtors and anything under
 * them. Payable: Sundry Creditors, brokers and contractors included.
 */
export async function outstanding(tx: Tx, side: Side, asOn: string) {
  const s = await booksSettings(tx)
  const groups = await groupsUnder(tx, [side === 'receivable' ? 'SUNDRY_DEBTORS' : 'SUNDRY_CREDITORS'])
  const ledgers = await tx.ledger.findMany({
    where: { groupId: { in: [...groups] } },
    select: {
      id: true,
      name: true,
      billWise: true,
      partyType: true,
      group: { select: { name: true } },
      customer: { select: { code: true } },
      supplier: { select: { code: true } },
      broker: { select: { code: true } },
      contractor: { select: { code: true } },
    },
  })
  // The usual side: a customer's balance is a debit, a supplier's a credit.
  const usual = side === 'receivable' ? 1 : -1
  const end = new Date(`${asOn}T23:59:59.999+05:30`)
  const ids = ledgers.map((l) => l.id)
  const [refs, balances] = await Promise.all([
    tx.billRef.findMany({
      where: { ledgerId: { in: ids }, OR: [{ lineId: null }, { line: { voucher: { status: 'POSTED', date: { lte: end } } } }] },
      select: { ledgerId: true, kind: true, billNo: true, billDate: true, dueDate: true, amount: true, line: { select: { voucher: { select: { sourceType: true } } } } },
    }),
    ledgerFigures(tx, { from: fyStartOf(asOn, s.fyStartMonth), to: asOn }, s),
  ])
  const closing = new Map(balances.map((b) => [b.id, b.closing]))

  type Acc = { billNo: string; billDate: Date; dueDate: Date | null; amount: number; kind: string | null; raisedBy: string | null }
  const byLedger = new Map<string, Map<string, Acc>>()
  for (const r of refs) {
    const bills = byLedger.get(r.ledgerId) ?? new Map<string, Acc>()
    const b = bills.get(r.billNo) ?? { billNo: r.billNo, billDate: r.billDate, dueDate: r.dueDate, amount: 0, kind: null, raisedBy: null }
    b.amount = r2(b.amount + Number(r.amount))
    if (r.kind !== 'AGAINST_REF') {
      b.billDate = r.billDate
      b.dueDate = r.dueDate
      b.kind = r.kind
      // A document's own type; ACCOUNTS for a voucher typed in Accounts; null for an old bill brought in.
      b.raisedBy = r.line ? r.line.voucher.sourceType ?? 'ACCOUNTS' : null
    }
    bills.set(r.billNo, b)
    byLedger.set(r.ledgerId, bills)
  }

  const parties: OutstandingParty[] = []
  for (const l of ledgers) {
    const balance = r2(closing.get(l.id) ?? 0)
    const bills: OutstandingBill[] = []
    let inBills = 0
    for (const b of byLedger.get(l.id)?.values() ?? []) {
      if (Math.abs(b.amount) < 0.005) continue
      inBills = r2(inBills + b.amount)
      const billDate = istDay(b.billDate)
      const amount = r2(b.amount * usual)
      bills.push({
        billNo: b.billNo,
        billDate,
        dueDate: b.dueDate ? istDay(b.dueDate) : null,
        days: daysBetween(b.dueDate ? istDay(b.dueDate) : billDate, asOn),
        amount,
        kind: amount > 0 ? 'bill' : 'advance',
        raisedBy: b.raisedBy,
      })
    }
    const gap = r2(balance - inBills)
    if (Math.abs(gap) >= 0.005) {
      bills.push({ billNo: l.billWise ? 'Not split into bills' : 'Balance', billDate: s.booksStart ?? asOn, dueDate: null, days: 0, amount: r2(gap * usual), kind: 'unsplit', raisedBy: null })
    }
    if (!bills.length) continue
    bills.sort((a, b) => a.billDate.localeCompare(b.billDate) || a.billNo.localeCompare(b.billNo))
    const buckets: Record<Bucket, number> = { notDue: 0, d30: 0, d60: 0, d90: 0, over90: 0 }
    let due = 0
    let advance = 0
    for (const b of bills) {
      if (b.amount > 0) {
        due = r2(due + b.amount)
        const k = b.kind === 'unsplit' ? 'notDue' : bucketOf(b.days)
        buckets[k] = r2(buckets[k] + b.amount)
      } else advance = r2(advance - b.amount)
    }
    const master = l.customer ?? l.supplier ?? l.broker ?? l.contractor
    parties.push({
      ledgerId: l.id,
      name: l.name,
      partyType: l.partyType,
      partyCode: master?.code ?? null,
      group: l.group.name,
      bills,
      buckets,
      due,
      overdue: r2(due - buckets.notDue),
      advance,
      net: r2(due - advance),
    })
  }
  parties.sort((a, b) => b.net - a.net || a.name.localeCompare(b.name))
  const total = (k: 'due' | 'overdue' | 'advance' | 'net') => r2(parties.reduce((t, p) => t + p[k], 0))
  const buckets = Object.fromEntries(BUCKETS.map((k) => [k, r2(parties.reduce((t, p) => t + p.buckets[k], 0))])) as Record<Bucket, number>
  return {
    side,
    asOn,
    parties,
    summary: { parties: parties.length, due: total('due'), overdue: total('overdue'), advance: total('advance'), net: total('net'), buckets },
  }
}
