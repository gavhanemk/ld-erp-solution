import type { LedgerNature, Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../../middleware/errorHandler'
import { ADMIN_ROLES } from '../../lib/accessCatalog'
import { booksSettings, dayText, dayValue, istDay, type BooksSettings } from './books.service'

type Tx = Prisma.TransactionClient

/**
 * The books' dates and their history (Phase 7, 30 Nov 2026).
 *
 * Closing the books further is routine for anyone who approves in Accounts.
 * Reopening — moving the closing date back, or clearing it — is not: it needs
 * the "Reopen closed periods" right, given only by name, and a reason, and
 * every administrator is told. Moving the day the books start, once set,
 * needs a reason. Each is kept as a period event that is never changed after,
 * and a voucher changed while a reopening stands names it in its revision.
 */

/** The right, given only by ticking it, to move the books' closing date back or clear it. */
export const REOPEN_RIGHT = 'accounts.books-reopen'

export interface DatesChange {
  booksStart?: string
  lockedUpTo?: string | null
  reason?: string | null
}

/** What a change to the books' dates does. */
export function datesChangeOf(before: BooksSettings, body: DatesChange) {
  const lockChanges = body.lockedUpTo !== undefined && (body.lockedUpTo ?? null) !== (before.lockedUpTo ?? null)
  const reopening = lockChanges && !!before.lockedUpTo && (!body.lockedUpTo || body.lockedUpTo < before.lockedUpTo)
  const startMoves = !!body.booksStart && body.booksStart !== before.booksStart
  return { lockChanges, reopening, startMoves }
}

/** The checks on who may, and the reason: before anything is written. */
export function checkDatesChange(before: BooksSettings, body: DatesChange, mayReopen: boolean) {
  const { reopening, startMoves } = datesChangeOf(before, body)
  const reason = body.reason?.trim() ?? ''
  if (reopening) {
    if (!mayReopen) {
      throw new AppError(
        'Reopening a closed period needs the “Reopen closed periods” right (Settings → People). Closing the books further does not.',
        403,
        'REOPEN_FORBIDDEN',
      )
    }
    if (reason.length < 5) {
      throw new AppError('Say why the closed period is being reopened: it is kept with the reopening, and every administrator is told.', 400, 'REASON_REQUIRED')
    }
  }
  if (startMoves && before.booksStart && reason.length < 5) {
    throw new AppError('Say why the day the books start is moving: it is kept with the change.', 400, 'REASON_REQUIRED')
  }
}

/** Writes the period events for a change, in the caller's transaction. */
export async function recordDatesChange(tx: Tx, before: BooksSettings, body: DatesChange, userId: string) {
  const { lockChanges, reopening, startMoves } = datesChangeOf(before, body)
  const reason = body.reason?.trim() || null
  const userName = (await tx.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? null
  // The clock's time, not the transaction's start: events keep their order even when written together.
  const at = new Date()
  const events: Array<{ id: string; kind: 'CLOSED' | 'REOPENED' | 'START_SET' }> = []
  if (startMoves) {
    events.push(
      await tx.periodEvent.create({
        data: { kind: 'START_SET', fromDate: before.booksStart ? dayValue(before.booksStart) : null, toDate: dayValue(body.booksStart!), reason, userId, userName, at },
        select: { id: true, kind: true },
      }),
    )
  }
  if (lockChanges) {
    events.push(
      await tx.periodEvent.create({
        data: {
          kind: reopening ? 'REOPENED' : 'CLOSED',
          fromDate: before.lockedUpTo ? dayValue(before.lockedUpTo) : null,
          toDate: body.lockedUpTo ? dayValue(body.lockedUpTo) : null,
          reason,
          userId,
          userName,
          at,
        },
        select: { id: true, kind: true },
      }),
    )
  }
  return { events, userName }
}

/** Every administrator hears of a reopening, by the bell. */
export async function tellAdminsReopened(db: PrismaClient, before: BooksSettings, body: DatesChange, byName: string | null) {
  const admins = await db.user.findMany({ where: { role: { name: { in: ADMIN_ROLES } }, status: 'ACTIVE' }, select: { id: true } })
  if (!admins.length) return
  const now = body.lockedUpTo ? `closed only up to ${dayText(body.lockedUpTo)}` : 'open throughout'
  await db.notification.createMany({
    data: admins.map((a) => ({
      userId: a.id,
      channel: 'IN_APP' as const,
      type: 'BOOKS_REOPENED',
      title: 'Closed books reopened',
      message: `${byName ?? 'Someone'} reopened the books, which were closed up to ${dayText(before.lockedUpTo!)}: they are now ${now}. Reason: ${body.reason?.trim() ?? ''}`,
      metadata: { from: before.lockedUpTo, to: body.lockedUpTo ?? null },
    })),
  })
}

/**
 * A ledger with entries (or an opening balance) in a closed period keeps the
 * kind of account it is: moving it to an income, expense, asset or liability
 * group of another kind would restate accounts already filed.
 */
export async function refuseClosedRegroup(db: PrismaClient | Tx, ledger: { id: string; name: string; openingBalance: unknown }, from: LedgerNature, to: LedgerNature) {
  if (from === to) return
  const s = await booksSettings(db as Tx)
  if (!s.lockedUpTo) return
  const closedLines = await db.voucherLine.count({ where: { ledgerId: ledger.id, voucher: { status: 'POSTED', date: { lte: dayValue(s.lockedUpTo) } } } })
  const closedOpening = Number(ledger.openingBalance) !== 0 && !!s.booksStart && s.lockedUpTo >= s.booksStart
  if (!closedLines && !closedOpening) return
  throw new AppError(
    `${ledger.name} has ${closedLines ? 'entries' : 'an opening balance'} in the period closed up to ${dayText(s.lockedUpTo)}. Moving it to ${to === 'INCOME' || to === 'EXPENSE' || to === 'ASSET' ? 'an' : 'a'} ${to.toLowerCase()} group would restate those accounts: make a new ledger for what follows instead, or reopen the period.`,
    409,
    'CLOSED_PERIOD',
  )
}

/** The books' dates as they were changed, newest first, with how many voucher changes each reopening saw. */
export async function periodEvents(db: PrismaClient | Tx, take = 50) {
  const rows = await db.periodEvent.findMany({
    orderBy: { at: 'desc' },
    take,
    select: { id: true, kind: true, fromDate: true, toDate: true, reason: true, userName: true, at: true, _count: { select: { revisions: true } } },
  })
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    fromDate: r.fromDate ? istDay(r.fromDate) : null,
    toDate: r.toDate ? istDay(r.toDate) : null,
    reason: r.reason,
    userName: r.userName,
    at: r.at,
    voucherChanges: r._count.revisions,
  }))
}
