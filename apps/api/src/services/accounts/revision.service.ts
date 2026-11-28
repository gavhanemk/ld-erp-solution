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
