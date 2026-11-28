import type { Prisma, VoucherRevisionAction } from '@prisma/client'
import { istDay } from './books.service'

type Tx = Prisma.TransactionClient

/**
 * A voucher's revisions (Phase 7, 30 Nov 2026).
 *
 * Before anything about a voucher changes — altered, rewritten with its
 * document, cancelled, reinstated, taken out of the books, its bank dates set,
 * reversed — the voucher as it stands is kept whole under the next revision
 * number: header, lines, bills and bank dates as stored, with what changed,
 * why, who, and where from. It is written in the same transaction as the
 * change, so neither is ever saved without the other; the database refuses to
 * alter or delete it afterwards.
 */
export interface RevisionChange {
  action: VoucherRevisionAction
  reason?: string | null
  /** "accounts" for a voucher typed there, the document type for one its document wrote, "repost", "bank-reco". */
  source: string
  userId?: string | null
}

export async function keepRevision(tx: Tx, voucherId: string, change: RevisionChange): Promise<number> {
  const v = await tx.voucher.findUniqueOrThrow({
    where: { id: voucherId },
    include: { lines: { orderBy: { sortOrder: 'asc' }, include: { billRefs: true } } },
  })
  const revision = v.revision + 1
  const [user, periodEventId] = await Promise.all([
    change.userId ? tx.user.findUnique({ where: { id: change.userId }, select: { name: true } }) : null,
    reopeningCovering(tx, istDay(v.date)),
  ])
  await tx.voucherRevision.create({
    data: {
      voucherId,
      revision,
      action: change.action,
      // As stored: amounts as the database's decimals, dates as they are kept.
      snapshot: JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue,
      reason: change.reason?.trim() || null,
      source: change.source,
      changedById: change.userId ?? null,
      changedByName: user?.name ?? null,
      periodEventId,
    },
  })
  await tx.voucher.update({ where: { id: voucherId }, data: { revision } })
  return revision
}

/**
 * The reopening a day falls in while it stands: a REOPENED event that no
 * closing since has undone, whose reopened stretch (after its new closing
 * date, up to the one it moved back from) holds the day.
 */
export async function reopeningCovering(tx: Tx, day: string): Promise<string | null> {
  const reopenings = await tx.periodEvent.findMany({ where: { kind: 'REOPENED' }, orderBy: { at: 'desc' }, take: 24 })
  for (const r of reopenings) {
    if (!r.fromDate) continue
    const from = istDay(r.fromDate)
    const to = r.toDate ? istDay(r.toDate) : null
    if (!(day <= from && (!to || day > to))) continue
    // Closed again past the day it was reopened from: that reopening is over.
    const closedAgain = await tx.periodEvent.findFirst({ where: { kind: 'CLOSED', at: { gt: r.at }, toDate: { gte: r.fromDate } }, select: { id: true } })
    return closedAgain ? null : r.id
  }
  return null
}

/** A voucher as a revision keeps it, or as it stands now, read the same way. */
export interface VoucherSnap {
  date: string | Date
  narration: string | null
  amount: string | number | Prisma.Decimal
  status: string
  cancelReason: string | null
  mode: string | null
  referenceNo: string | null
  chequeNo: string | null
  lines: Array<{
    ledgerId: string
    debit: string | number | Prisma.Decimal
    credit: string | number | Prisma.Decimal
    costCentreId: string | null
    departmentId: string | null
    bankDate: string | Date | null
    billRefs: Array<{ billNo: string; amount: string | number | Prisma.Decimal }>
  }>
}

/** Names for the ids a voucher's lines carry. */
export interface SnapNames {
  ledger: (id: string) => string
  brand: (id: string | null) => string
  department: (id: string | null) => string
}

const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const onDay = (d: string | Date) => new Date(`${istDay(new Date(d))}T00:00:00+05:30`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
const clip = (s: string) => (s.length > 70 ? `${s.slice(0, 69)}…` : s)

/**
 * What one change did to a voucher, in words an accountant reads at a
 * glance: "Amount ₹500.00 → ₹750.00", "Rent: Dr ₹500.00 → Dr ₹750.00",
 * "Rent: brand Not split → Stich Code". Lines are compared ledger by
 * ledger, so a line moved up or down is not a change. Nothing changed in
 * the figures (a reversal, bank dates set to the same day) gives nothing.
 */
export function describeChange(before: VoucherSnap, after: VoucherSnap, names: SnapNames): string[] {
  const out: string[] = []
  if (before.status !== after.status) out.push(after.status === 'CANCELLED' ? 'Cancelled: its amounts stopped counting' : 'Back in force: its amounts count again')
  if (istDay(new Date(before.date)) !== istDay(new Date(after.date))) out.push(`Date ${onDay(before.date)} → ${onDay(after.date)}`)
  const a0 = Number(before.amount)
  const a1 = Number(after.amount)
  if (Math.abs(a0 - a1) >= 0.005) out.push(`Amount ${rupees(a0)} → ${rupees(a1)}`)

  interface Side {
    dr: number
    cr: number
    brands: Set<string>
    depts: Set<string>
    bank: Set<string>
    bills: string[]
  }
  const byLedger = (s: VoucherSnap) => {
    const m = new Map<string, Side>()
    for (const l of s.lines) {
      const e = m.get(l.ledgerId) ?? { dr: 0, cr: 0, brands: new Set<string>(), depts: new Set<string>(), bank: new Set<string>(), bills: [] }
      e.dr += Number(l.debit)
      e.cr += Number(l.credit)
      e.brands.add(names.brand(l.costCentreId))
      e.depts.add(names.department(l.departmentId))
      if (l.bankDate) e.bank.add(onDay(l.bankDate))
      for (const b of l.billRefs) e.bills.push(`${b.billNo} ${rupees(Math.abs(Number(b.amount)))}`)
      m.set(l.ledgerId, e)
    }
    return m
  }
  const side = (e: Side) => (e.dr >= e.cr ? `Dr ${rupees(e.dr - e.cr)}` : `Cr ${rupees(e.cr - e.dr)}`)
  const list = (s: Set<string> | string[]) => [...s].sort().join(', ')
  const m0 = byLedger(before)
  const m1 = byLedger(after)
  for (const id of new Set([...m0.keys(), ...m1.keys()])) {
    const x = m0.get(id)
    const y = m1.get(id)
    const name = names.ledger(id)
    if (!x && y) out.push(`${name} added: ${side(y)}`)
    else if (x && !y) out.push(`${name} taken off: it was ${side(x)}`)
    else if (x && y) {
      if (Math.abs(x.dr - y.dr) >= 0.005 || Math.abs(x.cr - y.cr) >= 0.005) out.push(`${name}: ${side(x)} → ${side(y)}`)
      if (list(x.brands) !== list(y.brands)) out.push(`${name}: brand ${list(x.brands)} → ${list(y.brands)}`)
      if (list(x.depts) !== list(y.depts)) out.push(`${name}: department ${list(x.depts)} → ${list(y.depts)}`)
      if (list(x.bank) !== list(y.bank)) out.push(y.bank.size ? `${name}: in the bank on ${list(y.bank)}${x.bank.size ? ` (was ${list(x.bank)})` : ''}` : `${name}: bank date taken off`)
      if (list(x.bills) !== list(y.bills)) out.push(`${name}: bills ${list(x.bills) || 'none'} → ${list(y.bills) || 'none'}`)
    }
  }
  if ((before.narration ?? '') !== (after.narration ?? '')) out.push(`Narration “${clip(before.narration ?? '')}” → “${clip(after.narration ?? '')}”`)
  for (const [key, label] of [
    ['mode', 'Paid by'],
    ['referenceNo', 'Reference'],
    ['chequeNo', 'Cheque'],
  ] as const) {
    if ((before[key] ?? '') !== (after[key] ?? '')) out.push(`${label} ${before[key] || 'none'} → ${after[key] || 'none'}`)
  }
  return out
}
