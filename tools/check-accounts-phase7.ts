// Phase 7 of the multi-brand plan, final controls and audit (30 Nov 2026):
//
//   - every change to a voucher is kept as a numbered revision holding the
//     voucher exactly as it stood, with who, when, why and where from;
//   - nothing in the books is deleted, and the trail is never rewritten: the
//     database refuses both, unless a session says so outright;
//   - a closed period is frozen, but for which bills its amounts settle; its
//     bank reconciliation stays as filed;
//   - a voucher typed in Accounts is corrected by a reversing entry on an open
//     day, which leaves it as it was and puts its bills back;
//   - reopening a closed period needs its own right ("Reopen closed periods",
//     given only by name) and a reason; a voucher changed while it stands
//     names it; closing further needs neither;
//   - a ledger with closed-period entries keeps the kind of account it is;
//   - Settings → Company no longer moves the books' start, nor the year's
//     first month once there are vouchers.
//
// Everything runs inside one transaction that always rolls back, so nothing is
// kept; the API checks at the end are refusals, which change nothing. From
// apps/api, with the demo database and the admin's E2E_* sign-in:
//
//   npx tsx ../../tools/check-accounts-phase7.ts
import { prisma } from '../packages/database/src/index'
import type { Prisma } from '@prisma/client'
import { ensureChart } from '../apps/api/src/services/accounts/chart.service'
import { booksSettings, dayValue, istDay, openBills, todayIst } from '../apps/api/src/services/accounts/books.service'
import { cancelVoucher, reverseVoucher, voucherSchema, writeVoucher, type VoucherInput } from '../apps/api/src/services/accounts/voucher.service'
import { postDocument } from '../apps/api/src/services/accounts/posting.service'
import { setBankDates } from '../apps/api/src/services/accounts/bankReco.service'
import { checkDatesChange, recordDatesChange, refuseClosedRegroup, REOPEN_RIGHT } from '../apps/api/src/services/accounts/period.service'
import { reopeningCovering } from '../apps/api/src/services/accounts/revision.service'
import { expandGrants, grantsAllow } from '../apps/api/src/lib/access'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra: unknown = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && extra !== '' ? ' — ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')

/** Runs `fn` and says whether it was refused with this code. */
async function refused(fn: () => Promise<unknown>, code: string): Promise<true | string> {
  try {
    await fn()
    return 'not refused'
  } catch (e) {
    const got = (e as { code?: string }).code
    return got === code ? true : `refused with ${got ?? (e as Error).message.split('\n').slice(-1)[0]}`
  }
}
const why = (r: true | string) => (r === true ? '' : r)

/** Runs `fn` in a savepoint and says whether the database refused it with this message. */
async function dbRefused(tx: Prisma.TransactionClient, fn: () => Promise<unknown>, marker: string): Promise<true | string> {
  await tx.$executeRawUnsafe('SAVEPOINT p7_refused')
  try {
    await fn()
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT p7_refused')
    return 'not refused'
  } catch (e) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT p7_refused')
    return (e as Error).message.includes(marker) ? true : `refused otherwise: ${(e as Error).message.split('\n').slice(-1)[0]}`
  }
}

async function main() {
  await ensureChart()
  const user = await prisma.user.findFirst({ where: { status: 'ACTIVE', role: { name: { in: ['Super Admin', 'Admin'] } } }, select: { id: true, name: true } })
  if (!user) throw new Error('Needs an active administrator')
  try {
    await prisma.$transaction(
      async (tx) => {
        await run(tx, user)
        throw ROLLBACK
      },
      { timeout: 180_000 },
    )
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  await apiChecks()
  console.log(`\n${pass} passed, ${fail} failed`)
  // Set, not process.exit(): exiting while fetch's connections close trips a libuv assertion on Windows.
  process.exitCode = fail ? 1 : 0
}

async function run(tx: Prisma.TransactionClient, user: { id: string; name: string }) {
  const today = todayIst()
  // Last month is the one to close: the books start on its first day.
  const lastEnd = istDay(new Date(dayValue(`${today.slice(0, 8)}01`).getTime() - 86_400_000))
  const start = `${lastEnd.slice(0, 8)}01`
  const midLast = `${lastEnd.slice(0, 8)}15`
  const company = await tx.company.findFirstOrThrow({ select: { id: true } })
  const setDates = (d: { booksStartDate?: Date; booksLockedUpTo?: Date | null }) => tx.company.update({ where: { id: company.id }, data: d })
  await setDates({ booksStartDate: dayValue(start), booksLockedUpTo: null })

  // ── Ledgers of this check's own ──
  const group = (k: string) => tx.ledgerGroup.findUniqueOrThrow({ where: { systemKey: k } })
  const dept = await tx.department.findFirstOrThrow({ where: { isActive: true }, select: { id: true } })
  const rent = await tx.ledger.create({ data: { name: 'ZZTEST P7 Rent', groupId: (await group('INDIRECT_EXPENSES')).id, departmentId: dept.id } })
  const capital = await tx.ledger.create({ data: { name: 'ZZTEST P7 Capital', groupId: (await group('CAPITAL')).id } })
  const sales = (await tx.ledger.findUniqueOrThrow({ where: { systemKey: 'SALES' }, select: { id: true } })).id
  const bank = await tx.ledger.findFirstOrThrow({ where: { partyType: 'BANK', isActive: true, bankAccountId: { not: null } }, select: { id: true } })
  const customer = await tx.ledger.findFirstOrThrow({ where: { partyType: 'CUSTOMER', isActive: true, billWise: true }, select: { id: true } })
  const v = (o: Partial<VoucherInput> & Pick<VoucherInput, 'kind' | 'lines'>): VoucherInput => voucherSchema.parse({ date: today, ...o })
  const journal = (amount: number, date = today) =>
    writeVoucher(tx, v({ kind: 'JOURNAL', date, narration: 'ZZTEST P7', lines: [{ ledgerId: rent.id, side: 'DR', amount }, { ledgerId: capital.id, side: 'CR', amount }] }), user.id)
  const load = (id: string) => tx.voucher.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { sortOrder: 'asc' }, include: { billRefs: true } } } })
  const revs = (id: string) => tx.voucherRevision.findMany({ where: { voucherId: id }, orderBy: { revision: 'asc' } })

  // ── 1. Altering keeps what it said before, whole, with who and why ──
  const j1 = await journal(1000, midLast)
  const asWas = await load(j1.id)
  await writeVoucher(tx, v({ kind: 'JOURNAL', date: midLast, narration: 'ZZTEST P7 altered', lines: [{ ledgerId: rent.id, side: 'DR', amount: 1200 }, { ledgerId: capital.id, side: 'CR', amount: 1200 }] }), user.id, {
    id: j1.id,
    kind: 'JOURNAL',
    voucherNo: j1.voucherNo,
    financialYear: asWas.financialYear,
    date: asWas.date,
    reason: 'Rent is ₹1,200, not ₹1,000',
  })
  const [r1] = await revs(j1.id)
  const snap = r1?.snapshot as unknown as { amount: string; narration: string; lines: Array<{ debit: string; credit: string }> }
  check(
    'altered: revision 1 holds the voucher as it stood (₹1,000, its narration and lines), with who, why and where from',
    !!r1 && r1.revision === 1 && r1.action === 'ALTERED' && Number(snap.amount) === 1000 && snap.narration === 'ZZTEST P7' && snap.lines.length === 2 && r1.changedById === user.id && r1.changedByName === user.name && r1.reason === 'Rent is ₹1,200, not ₹1,000' && r1.source === 'accounts',
    r1,
  )
  const j1Now = await load(j1.id)
  check('…and the voucher now says ₹1,200, revision 1, altered by the same person', Number(j1Now.amount) === 1200 && j1Now.revision === 1 && j1Now.updatedById === user.id)

  // ── 2. Cancelling keeps a revision too ──
  const jc = await journal(50)
  await cancelVoucher(tx, jc.id, 'Entered twice', user.id)
  const [rc] = await revs(jc.id)
  check('cancelled: a revision of it as it stood (posted), with the reason; the voucher kept, cancelled', rc?.action === 'CANCELLED' && rc.reason === 'Entered twice' && (rc.snapshot as { status: string }).status === 'POSTED' && (await load(jc.id)).status === 'CANCELLED')

  // ── 3. The database refuses deletes, and any change to the trail ──
  const del = await dbRefused(tx, () => tx.voucher.delete({ where: { id: jc.id } }), 'BOOKS_NO_DELETE')
  check('the database refuses to delete a voucher, even a cancelled one', del === true, why(del))
  const delLines = await dbRefused(tx, () => tx.voucher.deleteMany({ where: { id: { in: [jc.id, j1.id] } } }), 'BOOKS_NO_DELETE')
  check('…or many at once', delLines === true, why(delLines))
  const upd = await dbRefused(tx, () => tx.voucherRevision.update({ where: { id: rc!.id }, data: { reason: 'rewritten' } }), 'BOOKS_TRAIL_FIXED')
  check('a revision is never changed once written', upd === true, why(upd))
  const delRev = await dbRefused(tx, () => tx.voucherRevision.delete({ where: { id: rc!.id } }), 'BOOKS_NO_DELETE')
  check('…nor deleted', delRev === true, why(delRev))
  await tx.$executeRawUnsafe('SAVEPOINT p7_flag')
  await tx.$executeRawUnsafe(`SELECT set_config('ld_erp.allow_books_delete', 'on', true)`)
  const flagged = await tx.voucher.delete({ where: { id: jc.id } }).then(() => true, () => false)
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT p7_flag')
  const flagGone = (await tx.$queryRawUnsafe<Array<{ v: string | null }>>(`SELECT current_setting('ld_erp.allow_books_delete', true) v`))[0]?.v
  check('only a session that says so outright may delete (the test tools, in a transaction they roll back); the say-so ends with it', flagged && flagGone !== 'on' && !!(await tx.voucher.findUnique({ where: { id: jc.id } })), { flagged, flagGone })

  // ── 4. A document's voucher taken out of the books is kept, cancelled, and stands again with it ──
  const docV = await tx.voucher.findFirst({ where: { sourceType: 'SALES_INVOICE', status: 'POSTED' }, orderBy: { date: 'desc' }, select: { id: true, sourceId: true, date: true, voucherNo: true } })
  if (docV?.sourceId) {
    const day = istDay(docV.date)
    const before = await load(docV.id)
    await setDates({ booksStartDate: dayValue(istDay(new Date(docV.date.getTime() + 86_400_000))) })
    const out = await postDocument(tx, 'SALES_INVOICE', docV.sourceId, user.id)
    const gone = await tx.voucher.findUnique({ where: { id: docV.id }, select: { status: true, cancelReason: true, lines: { select: { id: true } } } })
    const [rr] = (await revs(docV.id)).slice(-1)
    check(
      `the books starting after ${docV.voucherNo} (${day}): its voucher is not deleted but cancelled, its lines kept, with the reason, its revision taken`,
      out === 'removed' && gone?.status === 'CANCELLED' && /before they start/.test(gone.cancelReason ?? '') && gone.lines.length === before.lines.length && rr?.action === 'REMOVED' && rr.source === 'SALES_INVOICE',
      { out, gone: gone?.status, reason: gone?.cancelReason, rr: rr?.action },
    )
    await setDates({ booksStartDate: dayValue(start) })
    const back = await postDocument(tx, 'SALES_INVOICE', docV.sourceId, user.id)
    const stands = await load(docV.id)
    const [rb] = (await revs(docV.id)).slice(-1)
    check('…and with the start moved back it stands again, the same number and money, as a REINSTATED revision', back === 'updated' && stands.status === 'POSTED' && stands.voucherNo === docV.voucherNo && Number(stands.amount) === Number(before.amount) && rb?.action === 'REINSTATED', { back, s: stands.status, rb: rb?.action })
  } else {
    console.log('SKIP the document-voucher checks: no posted invoice voucher in this database')
  }

  // ── 5. Bills: a reversing entry puts each back; a settled bill is refused until its settlement is undone ──
  const raise = await writeVoucher(tx, v({ kind: 'JOURNAL', narration: 'ZZTEST P7 bill', lines: [{ ledgerId: customer.id, side: 'DR', amount: 500, bills: [{ kind: 'NEW_REF', billNo: 'ZZ-P7-1', amount: 500 }] }, { ledgerId: sales, side: 'CR', amount: 500 }] }), user.id)
  const settle = await writeVoucher(tx, v({ kind: 'RECEIPT', mode: 'NEFT', lines: [{ ledgerId: bank.id, side: 'DR', amount: 500 }, { ledgerId: customer.id, side: 'CR', amount: 500, bills: [{ kind: 'AGAINST_REF', billNo: 'ZZ-P7-1', amount: 500 }] }] }), user.id)
  const settledFirst = await refused(() => reverseVoucher(tx, raise.id, { date: today, reason: 'Wrong customer' }, user.id), 'BILL_SETTLED')
  check('reversing the journal that raised a bill already settled: refused, naming the receipt', settledFirst === true, why(settledFirst))
  const unsettle = await reverseVoucher(tx, settle.id, { date: today, reason: 'Cheque came back' }, user.id)
  const unsettled = await load(unsettle.id)
  check('the receipt reversed: a payment, the same ledgers, debits and credits swapped, pointing at it', unsettled.kind === 'PAYMENT' && unsettled.reversalOfId === settle.id && unsettled.lines.some((l) => l.ledgerId === bank.id && Number(l.credit) === 500) && unsettled.lines.some((l) => l.ledgerId === customer.id && Number(l.debit) === 500))
  const open1 = (await openBills(tx, customer.id)).find((b) => b.billNo === 'ZZ-P7-1')
  check('…and bill ZZ-P7-1 is open again for its ₹500', open1?.pending === 500, open1)
  const unraise = await reverseVoucher(tx, raise.id, { date: today, reason: 'Wrong customer' }, user.id)
  const open2 = (await openBills(tx, customer.id)).find((b) => b.billNo === 'ZZ-P7-1')
  check('with its settlement undone, the journal reverses too, and the bill is gone', !!unraise.voucherNo && !open2, open2)

  // ── 6. Reversing entries: never altered; the voucher they undo stays as it was ──
  const j2 = await journal(300)
  const r2v = await reverseVoucher(tx, j2.id, { date: today, reason: 'Booked to the wrong month' }, user.id)
  const j2Now = await load(j2.id)
  const [j2rev] = await revs(j2.id)
  check('reversed: the voucher itself unchanged (posted, ₹300), its history naming the reversing entry', j2Now.status === 'POSTED' && Number(j2Now.amount) === 300 && j2rev?.action === 'REVERSED' && (j2rev.reason ?? '').includes(r2v.voucherNo))
  const again = await refused(() => reverseVoucher(tx, j2.id, { date: today, reason: 'twice' }, user.id), 'ALREADY_REVERSED')
  const ofReversal = await refused(() => reverseVoucher(tx, r2v.id, { date: today, reason: 'undo' }, user.id), 'IS_REVERSAL')
  const r2Load = await load(r2v.id)
  const alterReversal = await refused(
    () => writeVoucher(tx, v({ kind: 'JOURNAL', lines: [{ ledgerId: rent.id, side: 'CR', amount: 1 }, { ledgerId: capital.id, side: 'DR', amount: 1 }] }), user.id, { id: r2v.id, kind: 'JOURNAL', voucherNo: r2v.voucherNo, financialYear: r2Load.financialYear, date: r2Load.date }),
    'IS_REVERSAL',
  )
  const alterReversed = await refused(
    () => writeVoucher(tx, v({ kind: 'JOURNAL', lines: [{ ledgerId: rent.id, side: 'DR', amount: 9 }, { ledgerId: capital.id, side: 'CR', amount: 9 }] }), user.id, { id: j2.id, kind: 'JOURNAL', voucherNo: j2.voucherNo, financialYear: j2Now.financialYear, date: j2Now.date }),
    'REVERSED',
  )
  const cancelReversed = await refused(() => cancelVoucher(tx, j2.id, 'no longer', user.id), 'REVERSED')
  check('not reversed twice, a reversal not reversed nor altered, the undone voucher neither altered nor cancelled', [again, ofReversal, alterReversal, alterReversed, cancelReversed].every((r) => r === true), [again, ofReversal, alterReversal, alterReversed, cancelReversed])
  await cancelVoucher(tx, r2v.id, 'Reversed by mistake', user.id)
  const again2 = await reverseVoucher(tx, j2.id, { date: today, reason: 'Booked to the wrong month after all' }, user.id)
  check('with its reversing entry cancelled, the voucher is in force again and can be reversed anew', !!again2.voucherNo)

  // ── 7. A closed period ──
  const pay = await writeVoucher(tx, v({ kind: 'PAYMENT', date: midLast, mode: 'CHEQUE', chequeNo: '000777', chequeDate: midLast, lines: [{ ledgerId: rent.id, side: 'DR', amount: 400 }, { ledgerId: bank.id, side: 'CR', amount: 400 }] }), user.id)
  const bankLine = (await load(pay.id)).lines.find((l) => l.ledgerId === bank.id)!
  await setDates({ booksLockedUpTo: dayValue(lastEnd) })
  const j1Closed = await load(j1.id)
  const alterClosed = await refused(
    () => writeVoucher(tx, v({ kind: 'JOURNAL', date: midLast, lines: [{ ledgerId: rent.id, side: 'DR', amount: 1 }, { ledgerId: capital.id, side: 'CR', amount: 1 }] }), user.id, { id: j1.id, kind: 'JOURNAL', voucherNo: j1.voucherNo, financialYear: j1Closed.financialYear, date: j1Closed.date }),
    'PERIOD_LOCKED',
  )
  const cancelClosed = await refused(() => cancelVoucher(tx, j1.id, 'too late', user.id), 'PERIOD_LOCKED')
  const reverseIntoClosed = await refused(() => reverseVoucher(tx, j1.id, { date: midLast, reason: 'into the closed month' }, user.id), 'PERIOD_LOCKED')
  check(`closed up to ${lastEnd}: its voucher is neither altered nor cancelled, nor reversed into the closed month`, [alterClosed, cancelClosed, reverseIntoClosed].every((r) => r === true), [alterClosed, cancelClosed, reverseIntoClosed])
  const fix = await reverseVoucher(tx, j1.id, { date: today, reason: 'October rent was booked twice' }, user.id)
  const fixed = await load(fix.id)
  const j1After = await load(j1.id)
  const net = await tx.voucherLine.aggregate({ where: { ledgerId: rent.id, voucherId: { in: [j1.id, fix.id] } }, _sum: { debit: true, credit: true } })
  check(
    "…it is corrected by a reversing entry on an open day: the closed month's voucher exactly as it was, the two netting to nothing",
    istDay(fixed.date) === today && fixed.reversalOfId === j1.id && j1After.status === 'POSTED' && Number(j1After.amount) === 1200 && j1After.lines.length === 2 && Number(net._sum.debit) === Number(net._sum.credit),
    { net: net._sum, date: istDay(fixed.date) },
  )
  const inClosed = await refused(() => setBankDates(tx, [{ lineId: bankLine.id, bankDate: `${lastEnd.slice(0, 8)}20` }], user.id), 'PERIOD_LOCKED')
  check("a bank date on or before the closing day is not set: the closed month's reconciliation stays as filed", inClosed === true, why(inClosed))
  const cleared = `${today.slice(0, 8)}02` <= today ? `${today.slice(0, 8)}02` : today
  await setBankDates(tx, [{ lineId: bankLine.id, bankDate: cleared }], user.id)
  const [bankRev] = (await revs(pay.id)).slice(-1)
  check(`…a cheque written in the closed month and cleared after (${cleared}) takes its date, with a BANK_DATES revision by who set it`, bankRev?.action === 'BANK_DATES' && bankRev.changedById === user.id && bankRev.source === 'bank-reco')
  await setBankDates(tx, [{ lineId: bankLine.id, bankDate: null }], user.id)
  check('…and that open-month date can be cleared again', (await tx.voucherLine.findUniqueOrThrow({ where: { id: bankLine.id } })).bankDate === null)

  // A document's voucher in a closed period keeps every word it was closed with.
  if (docV?.sourceId) {
    await setDates({ booksLockedUpTo: dayValue(istDay(docV.date)) })
    await tx.voucher.update({ where: { id: docV.id }, data: { narration: 'ZZTEST P7 as filed' } })
    const n0 = (await revs(docV.id)).length
    const r = await postDocument(tx, 'SALES_INVOICE', docV.sourceId, user.id)
    const kept = await tx.voucher.findUniqueOrThrow({ where: { id: docV.id }, select: { narration: true } })
    check("a document's voucher in a closed period: a difference in its wording is left as filed, no rewrite, no revision", r === 'unchanged' && kept.narration === 'ZZTEST P7 as filed' && (await revs(docV.id)).length === n0, { r, n: kept.narration })
    await setDates({ booksLockedUpTo: dayValue(lastEnd) })
  }

  // A ledger with closed-period entries keeps the kind of account it is.
  const regroup = await refused(() => refuseClosedRegroup(tx, rent, 'EXPENSE', 'ASSET'), 'CLOSED_PERIOD')
  const fresh = await tx.ledger.create({ data: { name: 'ZZTEST P7 Fresh', groupId: (await group('INDIRECT_EXPENSES')).id } })
  const freshOk = await refuseClosedRegroup(tx, fresh, 'EXPENSE', 'ASSET').then(() => true, () => false)
  check('a ledger with entries in the closed period cannot move to a group of another kind; one without can', regroup === true && freshOk, why(regroup))

  // ── 8. Reopening: its own right and a reason; what changes while it stands names it ──
  const s0 = await booksSettings(tx)
  const back = `${lastEnd.slice(0, 8)}01` > start ? istDay(new Date(dayValue(`${lastEnd.slice(0, 8)}01`).getTime() - 86_400_000)) : start
  const noRight = await refused(async () => checkDatesChange(s0, { lockedUpTo: back, reason: 'Late purchase bill' }, false), 'REOPEN_FORBIDDEN')
  const noReason = await refused(async () => checkDatesChange(s0, { lockedUpTo: null }, true), 'REASON_REQUIRED')
  const further = await refused(async () => checkDatesChange(s0, { lockedUpTo: today }, false), 'none')
  const dayBeforeStart = istDay(new Date(dayValue(start).getTime() - 86_400_000))
  const startNoReason = await refused(async () => checkDatesChange(s0, { booksStart: dayBeforeStart }, true), 'REASON_REQUIRED')
  check('reopening without the right: refused; with it but no reason: refused; moving the start: a reason', noRight === true && noReason === true && startNoReason === true, [noRight, noReason, startNoReason])
  check('closing further needs neither the right nor a reason', further === 'not refused', further)
  const { events: reopenEvents } = await recordDatesChange(tx, s0, { lockedUpTo: back, reason: 'October purchase bill came in late' }, user.id)
  await setDates({ booksLockedUpTo: dayValue(back) })
  const reopened = reopenEvents.find((e) => e.kind === 'REOPENED')
  const ev = reopened ? await tx.periodEvent.findUniqueOrThrow({ where: { id: reopened.id } }) : null
  check('the reopening is kept: from the old closing day to the new, the reason, who', ev?.kind === 'REOPENED' && istDay(ev.fromDate!) === lastEnd && istDay(ev.toDate!) === back && ev.reason === 'October purchase bill came in late' && ev.userName === user.name, ev)
  const j3 = await journal(75, midLast)
  const j3Load = await load(j3.id)
  await writeVoucher(tx, v({ kind: 'JOURNAL', date: midLast, lines: [{ ledgerId: rent.id, side: 'DR', amount: 80 }, { ledgerId: capital.id, side: 'CR', amount: 80 }] }), user.id, { id: j3.id, kind: 'JOURNAL', voucherNo: j3.voucherNo, financialYear: j3Load.financialYear, date: j3Load.date, reason: 'Corrected while reopened' })
  const [j3rev] = await revs(j3.id)
  check('a voucher in the reopened month changed while it stands: its revision names the reopening', j3rev?.periodEventId === reopened?.id, j3rev?.periodEventId)
  const s1 = await booksSettings(tx)
  // Days apart in life; a few milliseconds here, so the two events keep their order.
  await new Promise((r) => setTimeout(r, 15))
  await recordDatesChange(tx, s1, { lockedUpTo: lastEnd }, user.id)
  await setDates({ booksLockedUpTo: dayValue(lastEnd) })
  check('closed again: the reopening is over, and no later change is put down to it', (await reopeningCovering(tx, midLast)) === null)
  const j4 = await journal(20)
  const j4Load = await load(j4.id)
  await writeVoucher(tx, v({ kind: 'JOURNAL', lines: [{ ledgerId: rent.id, side: 'DR', amount: 25 }, { ledgerId: capital.id, side: 'CR', amount: 25 }] }), user.id, { id: j4.id, kind: 'JOURNAL', voucherNo: j4.voucherNo, financialYear: j4Load.financialYear, date: j4Load.date, reason: 'Open month' })
  check("…an open month's change names none", (await revs(j4.id))[0]?.periodEventId === null)
  const evDel = await dbRefused(tx, () => tx.periodEvent.deleteMany({}), 'BOOKS_NO_DELETE')
  const evUpd = await dbRefused(tx, () => tx.periodEvent.updateMany({ data: { reason: 'rewritten' } }), 'BOOKS_TRAIL_FIXED')
  check('the books\' dates history is never deleted nor rewritten', evDel === true && evUpd === true, [evDel, evUpd])

  // ── 9. The right is given only by name ──
  check(
    `"Reopen closed periods" (${REOPEN_RIGHT}) is given only by ticking it: an Accounts-wide grant, Approve or * does not include it`,
    !grantsAllow(['accounts:approve', 'accounts:*'], REOPEN_RIGHT, 'approve') && grantsAllow([`${REOPEN_RIGHT}:approve`], REOPEN_RIGHT, 'approve') && !expandGrants(['accounts:approve', 'accounts:*']).includes(`${REOPEN_RIGHT}:approve`),
  )
}

/** Through the API: refusals only, which change nothing. */
async function apiChecks() {
  const API = process.env.E2E_API
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!API || !email || !password) {
    console.log('SKIP the API checks: set E2E_API, E2E_EMAIL and E2E_PASSWORD')
    return
  }
  const login = (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())) as { data?: { accessToken?: string }; accessToken?: string }
  const token = login.data?.accessToken ?? login.accessToken
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, body: (await r.json().catch(() => null)) as { code?: string; data?: unknown } | null }
  }
  const c = await prisma.company.findFirstOrThrow({ select: { fyStartMonth: true, booksStartDate: true } })
  const start = await call('PATCH', '/settings/company', { booksStartDate: '2020-01-01' })
  check('Settings → Company cannot move the day the books start: that is done in Accounts, with its checks', start.status === 409 && start.body?.code === 'BOOKS_START_IN_ACCOUNTS', start)
  const fy = await call('PATCH', '/settings/company', { fyStartMonth: c.fyStartMonth === 4 ? 1 : 4 })
  check('…nor the month the year starts in, once the books have vouchers', fy.status === 409 && fy.body?.code === 'FY_START_FIXED', fy)
  const after = await prisma.company.findFirstOrThrow({ select: { fyStartMonth: true, booksStartDate: true } })
  check('…and neither changed', after.fyStartMonth === c.fyStartMonth && String(after.booksStartDate) === String(c.booksStartDate))
  const perms = await call('GET', '/settings/permissions')
  const screens = JSON.stringify(perms.body?.data ?? '')
  check('the role editor lists "Reopen closed periods", given only by name', perms.status === 200 && screens.includes('"key":"accounts.books-reopen"') && /"key":"accounts.books-reopen"[^}]*"explicit":true/.test(screens), perms.status)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
