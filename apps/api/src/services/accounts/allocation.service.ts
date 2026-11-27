import type { AllocationBasis, Prisma } from '@prisma/client'
import { AppError } from '../../middleware/errorHandler'
import { nextDocumentNumber, financialYearOf } from '../../lib/docNumber'
import { booksSettings, dayText, r2, todayIst } from './books.service'

/*
 * Shared expenses split between the brands, month by month.
 *
 * An expense booked with no brand is shared: factory power, office rent,
 * machine maintenance. Each month a run takes every shared expense of the
 * month, finds the first rule that covers it (by ledger and department), and
 * splits it between the rule's brands on the rule's basis — each brand's
 * sales, pieces produced, material consumed, machine hours, fixed shares or
 * shares typed for the month. The shares of each split add up to 100%, and
 * the rupees to the shared amount, to the paisa.
 *
 * Posted, it is one journal: for each ledger and department, a debit for
 * each brand's share and one credit of the whole with no brand. The same
 * ledger and department on both sides, so the company's expenses — by
 * ledger and by department — do not move; only the brand split does.
 *
 * A run is worked out (draft), approved, then posted. Before approval and
 * again before posting it is worked out afresh and must come out the same:
 * an expense booked or changed in between stops it until it is worked out
 * again. Undone, it is reversed by a second, recorded journal; the month may
 * then run again. Only one run of a month is live at a time (the database
 * holds to that). Every run keeps the expenses it split, voucher by voucher.
 */

type Tx = Prisma.TransactionClient

export const BASIS_WORDS: Record<AllocationBasis, string> = {
  REVENUE: 'Sales that month',
  PRODUCTION_QTY: 'Pieces produced that month',
  MATERIAL_CONSUMPTION: 'Material consumed that month',
  MACHINE_HOURS: 'Machine hours (typed each month)',
  FIXED_PERCENT: 'Fixed percentages',
  MANUAL: 'Percentages typed on the run',
}

/** Bases whose figures are typed on the run, by brand. */
export const TYPED_BASES: AllocationBasis[] = ['MACHINE_HOURS', 'MANUAL']

/** What was typed for a run: rule → brand's profit centre → hours or percent. */
export type RunInputs = Record<string, Record<string, number>>

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-11" as its first and last day, and as people say it. */
export function monthOf(period: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(period)
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new AppError('Say which month, as 2026-11.', 400, 'BAD_PERIOD')
  const y = Number(m[1])
  const mo = Number(m[2])
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  const from = `${m[1]}-${m[2]}-01`
  const to = `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`
  if (from > todayIst()) throw new AppError('A month that has not begun has nothing to split.', 400, 'FUTURE_PERIOD')
  return { from, to, words: `${MONTHS[mo - 1]} ${y}` }
}

/** The month's days as the books keep them (a voucher is dated at the start of its day). */
const span = (from: string, to: string) => ({ gte: new Date(`${from}T00:00:00+05:30`), lte: new Date(`${to}T23:59:59.999+05:30`) })

/** Each ledger group's standard group at the top of its tree, in the query. */
const TOP_GROUP = `
  WITH RECURSIVE tree AS (
    SELECT id, "parentId", "systemKey" AS key FROM ld_erp.ledger_groups WHERE "parentId" IS NULL
    UNION ALL
    SELECT g.id, g."parentId", t.key FROM ld_erp.ledger_groups g JOIN tree t ON g."parentId" = t.id
  )`

/**
 * The month's shared expenses, voucher by voucher: expense lines with no
 * brand. Stock purchases (central until stock moves to a brand), round off
 * and the allocation journals themselves are left out.
 */
async function sharedExpenses(tx: Tx, from: string, to: string) {
  const { gte, lte } = span(from, to)
  return tx.$queryRawUnsafe<Array<{ voucherId: string; ledgerId: string; departmentId: string | null; amount: number }>>(
    `${TOP_GROUP}
     SELECT l."voucherId", l."ledgerId", l."departmentId", SUM(l.debit - l.credit)::float8 AS amount
       FROM ld_erp.acc_voucher_lines l
       JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
       JOIN ld_erp.ledgers led ON led.id = l."ledgerId"
       JOIN ld_erp.ledger_groups g ON g.id = led."groupId"
       JOIN tree t ON t.id = g.id
      WHERE v.status = 'POSTED' AND v.date >= $1 AND v.date <= $2
        AND g.nature::text = 'EXPENSE' AND l."costCentreId" IS NULL
        AND COALESCE(t.key, '') <> 'PURCHASE_ACCOUNTS'
        AND COALESCE(led."systemKey", '') <> 'ROUND_OFF'
        AND COALESCE(v."sourceType", '') NOT IN ('EXPENSE_ALLOCATION', 'EXPENSE_ALLOCATION_REVERSAL')
      GROUP BY l."voucherId", l."ledgerId", l."departmentId"
     HAVING SUM(l.debit - l.credit) <> 0`,
    gte,
    lte,
  )
}

type Centre = { id: string; name: string; brandId: string | null }

/** The brands a rule shares between: its own list, else every own brand's profit centre in use. */
async function centresOf(tx: Tx, costCentreIds: string[]): Promise<Centre[]> {
  return tx.costCentre.findMany({
    where: costCentreIds.length ? { id: { in: costCentreIds } } : { isActive: true, brand: { isActive: true, type: { not: 'CUSTOM' } } },
    select: { id: true, name: true, brandId: true },
    orderBy: { name: 'asc' },
  })
}

/** Each brand's figure on a basis for the month; typed bases come from the run. */
async function basisFigures(tx: Tx, basis: AllocationBasis, centres: Centre[], from: string, to: string, typed: Record<string, number> | undefined, fixed: Map<string, number>) {
  const out = new Map<string, number>()
  const { gte, lte } = span(from, to)
  const brandOf = new Map(centres.filter((c) => c.brandId).map((c) => [c.brandId!, c.id]))
  if (basis === 'FIXED_PERCENT') {
    for (const c of centres) out.set(c.id, fixed.get(c.id) ?? 0)
  } else if (basis === 'MANUAL' || basis === 'MACHINE_HOURS') {
    for (const c of centres) out.set(c.id, Number(typed?.[c.id] ?? 0))
  } else if (basis === 'REVENUE') {
    const rows = await tx.$queryRawUnsafe<Array<{ costCentreId: string; amount: number }>>(
      `${TOP_GROUP}
       SELECT l."costCentreId", SUM(l.credit - l.debit)::float8 AS amount
         FROM ld_erp.acc_voucher_lines l
         JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
         JOIN ld_erp.ledgers led ON led.id = l."ledgerId"
         JOIN ld_erp.ledger_groups g ON g.id = led."groupId"
         JOIN tree t ON t.id = g.id
        WHERE v.status = 'POSTED' AND v.date >= $1 AND v.date <= $2 AND t.key = 'SALES_ACCOUNTS'
          AND l."costCentreId" = ANY($3::text[])
        GROUP BY l."costCentreId"`,
      gte,
      lte,
      centres.map((c) => c.id),
    )
    for (const c of centres) out.set(c.id, Math.max(0, r2(rows.find((r) => r.costCentreId === c.id)?.amount ?? 0)))
  } else if (basis === 'PRODUCTION_QTY') {
    const rows = await tx.$queryRaw<Array<{ brandId: string; qty: number }>>`
      SELECT mo."brandId", SUM(l.qty)::float8 AS qty
        FROM ld_erp.finished_goods_receipt_lines l
        JOIN ld_erp.finished_goods_receipts r ON r.id = l."receiptId"
        JOIN ld_erp.manufacturing_orders mo ON mo.id = r."moId"
       WHERE r."cancelledAt" IS NULL AND r."receiptDate" >= ${gte} AND r."receiptDate" <= ${lte}
       GROUP BY mo."brandId"`
    for (const c of centres) out.set(c.id, 0)
    for (const r of rows) if (brandOf.has(r.brandId)) out.set(brandOf.get(r.brandId)!, Number(r.qty))
  } else if (basis === 'MATERIAL_CONSUMPTION') {
    // Issued to each brand's orders, less what came back from the floor.
    const rows = await tx.$queryRaw<Array<{ brandId: string; value: number }>>`
      SELECT mo."brandId", SUM(CASE WHEN s."referenceType" = 'MATERIAL_REQUISITION' THEN s."outQty" * COALESCE(s."unitRate", 0) ELSE -s."inQty" * COALESCE(s."unitRate", 0) END)::float8 AS value
        FROM ld_erp.stock_ledger s
        JOIN ld_erp.material_requisitions mr ON mr.id = s."referenceId"
        JOIN ld_erp.manufacturing_orders mo ON mo.id = mr."moId"
       WHERE s."referenceType" IN ('MATERIAL_REQUISITION', 'MR_RETURN') AND s."transactionDate" >= ${gte} AND s."transactionDate" <= ${lte}
       GROUP BY mo."brandId"`
    for (const c of centres) out.set(c.id, 0)
    for (const r of rows) if (brandOf.has(r.brandId)) out.set(brandOf.get(r.brandId)!, Math.max(0, r2(Number(r.value))))
  }
  return out
}

/** Rupees split by percentages, the last taking what rounding leaves, so the parts add up. */
function splitRupees(amount: number, shares: Array<{ costCentreId: string; percent: number }>) {
  const live = shares.filter((s) => s.percent > 0)
  let left = r2(amount)
  return live.map((s, i) => {
    const part = i === live.length - 1 ? left : r2((amount * s.percent) / 100)
    left = r2(left - part)
    return { costCentreId: s.costCentreId, percent: s.percent, amount: part }
  })
}

export interface WorkedOut {
  period: string
  from: string
  to: string
  words: string
  rules: Array<{ ruleId: string; name: string; basis: AllocationBasis; shares: Array<{ costCentreId: string; name: string; basisValue: number; percent: number }>; covers: number; problem: string | null }>
  lines: Array<{ ruleId: string; ledgerId: string; ledger: string; departmentId: string | null; department: string | null; sharedAmount: number; splits: Array<{ costCentreId: string; name: string; basisValue: number; percent: number; amount: number }> }>
  notCovered: Array<{ ledgerId: string; ledger: string; departmentId: string | null; department: string | null; amount: number }>
  sources: Array<{ voucherId: string; ledgerId: string; departmentId: string | null; amount: number }>
  totals: { shared: number; allocated: number; notCovered: number }
  problems: string[]
}

/**
 * The month worked out: every shared expense, the rule that covers it, and
 * each brand's share. Nothing is written.
 */
export async function workOut(tx: Tx, period: string, inputs: RunInputs = {}): Promise<WorkedOut> {
  const { from, to, words } = monthOf(period)
  const [rows, rules, ledgers, depts] = await Promise.all([
    sharedExpenses(tx, from, to),
    tx.allocationRule.findMany({ where: { isActive: true }, include: { shares: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    tx.ledger.findMany({ select: { id: true, name: true } }),
    tx.department.findMany({ select: { id: true, name: true } }),
  ])
  const ledgerName = new Map(ledgers.map((l) => [l.id, l.name]))
  const deptName = new Map(depts.map((d) => [d.id, d.name]))

  // Each ledger and department's shared total, and the first rule that covers it.
  const groups = new Map<string, { ledgerId: string; departmentId: string | null; amount: number }>()
  for (const r of rows) {
    const k = `${r.ledgerId}|${r.departmentId ?? ''}`
    const g = groups.get(k) ?? { ledgerId: r.ledgerId, departmentId: r.departmentId, amount: 0 }
    g.amount = r2(g.amount + Number(r.amount))
    groups.set(k, g)
  }
  const covering = (g: { ledgerId: string; departmentId: string | null }) =>
    rules.find((rule) => (!rule.ledgerIds.length || rule.ledgerIds.includes(g.ledgerId)) && (!rule.departmentIds.length || (!!g.departmentId && rule.departmentIds.includes(g.departmentId))))

  const problems: string[] = []
  const ruleOut: WorkedOut['rules'] = []
  const shareCache = new Map<string, Array<{ costCentreId: string; name: string; basisValue: number; percent: number }>>()
  for (const rule of rules) {
    const centres = await centresOf(tx, rule.costCentreIds)
    const fixed = new Map(rule.shares.map((s) => [s.costCentreId, Number(s.percent)]))
    const figures = await basisFigures(tx, rule.basis, centres, from, to, inputs[rule.id], fixed)
    const total = r2([...figures.values()].reduce((t, v) => t + v, 0))
    let problem: string | null = null
    let shares: Array<{ costCentreId: string; name: string; basisValue: number; percent: number }> = []
    if (!centres.length) problem = `${rule.name}: no brand to share between.`
    else if (rule.basis === 'FIXED_PERCENT' || rule.basis === 'MANUAL') {
      if (Math.abs(total - 100) > 0.0001) problem = `${rule.name}: the shares add up to ${total}%, not 100%.`
      shares = centres.map((c) => ({ costCentreId: c.id, name: c.name, basisValue: figures.get(c.id) ?? 0, percent: figures.get(c.id) ?? 0 }))
    } else if (!(total > 0)) {
      problem = `${rule.name}: no ${BASIS_WORDS[rule.basis].toLowerCase()} for these brands in ${words}, so there is nothing to split by. Choose another basis, or type the shares.`
    } else {
      // Percentages to six places, the last one taking the rounding so they make 100 exactly.
      let left = 100
      const withShare = centres.filter((c) => (figures.get(c.id) ?? 0) > 0)
      shares = centres.map((c) => {
        const v = figures.get(c.id) ?? 0
        if (!(v > 0)) return { costCentreId: c.id, name: c.name, basisValue: v, percent: 0 }
        const last = c.id === withShare[withShare.length - 1].id
        const p = last ? Math.round(left * 1e6) / 1e6 : Math.round(((v * 100) / total) * 1e6) / 1e6
        left = left - p
        return { costCentreId: c.id, name: c.name, basisValue: v, percent: p }
      })
    }
    shareCache.set(rule.id, shares)
    ruleOut.push({ ruleId: rule.id, name: rule.name, basis: rule.basis, shares, covers: 0, problem })
  }

  const lines: WorkedOut['lines'] = []
  const notCovered: WorkedOut['notCovered'] = []
  for (const g of groups.values()) {
    const rule = covering(g)
    if (!rule) {
      notCovered.push({ ...g, ledger: ledgerName.get(g.ledgerId) ?? '', department: g.departmentId ? (deptName.get(g.departmentId) ?? '') : null })
      continue
    }
    const ro = ruleOut.find((x) => x.ruleId === rule.id)!
    ro.covers++
    if (ro.problem) {
      if (!problems.includes(ro.problem)) problems.push(ro.problem)
      continue
    }
    const shares = shareCache.get(rule.id)!
    const splits = splitRupees(g.amount, shares).map((s) => ({ ...s, name: shares.find((x) => x.costCentreId === s.costCentreId)!.name, basisValue: shares.find((x) => x.costCentreId === s.costCentreId)!.basisValue }))
    lines.push({ ruleId: rule.id, ledgerId: g.ledgerId, ledger: ledgerName.get(g.ledgerId) ?? '', departmentId: g.departmentId, department: g.departmentId ? (deptName.get(g.departmentId) ?? '') : null, sharedAmount: g.amount, splits })
  }
  const covered = new Set(lines.map((l) => `${l.ledgerId}|${l.departmentId ?? ''}`))
  const shared = r2([...groups.values()].reduce((t, g) => t + g.amount, 0))
  const allocated = r2(lines.reduce((t, l) => t + l.splits.reduce((s, x) => s + x.amount, 0), 0))
  return {
    period,
    from,
    to,
    words,
    rules: ruleOut,
    lines,
    notCovered: notCovered.sort((a, b) => b.amount - a.amount),
    sources: rows.filter((r) => covered.has(`${r.ledgerId}|${r.departmentId ?? ''}`)).map((r) => ({ voucherId: r.voucherId, ledgerId: r.ledgerId, departmentId: r.departmentId, amount: r2(Number(r.amount)) })),
    totals: { shared, allocated, notCovered: r2(shared - allocated) },
    problems,
  }
}

/** A run's lines as written, to compare with a fresh working-out. */
const fingerprint = (lines: Array<{ ledgerId: string; departmentId: string | null; costCentreId: string; amount: number }>) =>
  lines
    .map((l) => `${l.ledgerId}|${l.departmentId ?? ''}|${l.costCentreId}|${r2(l.amount).toFixed(2)}`)
    .sort()
    .join(';')

const flat = (w: WorkedOut) => w.lines.flatMap((l) => l.splits.map((s) => ({ ledgerId: l.ledgerId, departmentId: l.departmentId, costCentreId: s.costCentreId, amount: s.amount, ruleId: l.ruleId, sharedAmount: l.sharedAmount, basisValue: s.basisValue, percent: s.percent })))

/** The year's run number series, made the first time a run of that year is saved. */
async function ensureSeries(tx: Tx, date: Date) {
  const company = await tx.company.findFirst({ select: { id: true, fyStartMonth: true } })
  if (!company) return
  const financialYear = financialYearOf(date, company.fyStartMonth ?? 4)
  const have = await tx.numberSeries.findFirst({ where: { companyId: company.id, docType: 'ALC', financialYear }, select: { id: true } })
  if (have) return
  await tx.numberSeries.create({ data: { companyId: company.id, docType: 'ALC', prefix: 'ALC', separator: '-', financialYear, lastNumber: 0, padding: 4 } })
}

/** Locks a run's row for the rest of the transaction. */
async function lockRun(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.acc_allocation_runs WHERE id = ${id} FOR UPDATE`
  const run = await tx.allocationRun.findUnique({ where: { id }, include: { lines: true } })
  if (!run) throw new AppError('That allocation run does not exist', 404, 'NOT_FOUND')
  return run
}

/** Writes what was worked out onto a run: its lines and the expenses they split. */
async function writeLines(tx: Tx, runId: string, w: WorkedOut) {
  await tx.allocationRunLine.deleteMany({ where: { runId } })
  await tx.allocationRunSource.deleteMany({ where: { runId } })
  const rows = flat(w)
  if (rows.length) {
    await tx.allocationRunLine.createMany({
      data: rows.map((r) => ({ runId, ruleId: r.ruleId, ledgerId: r.ledgerId, departmentId: r.departmentId, costCentreId: r.costCentreId, sharedAmount: r.sharedAmount, basisValue: r.basisValue, percent: r.percent, amount: r.amount })),
    })
  }
  if (w.sources.length) await tx.allocationRunSource.createMany({ data: w.sources.map((s) => ({ runId, ...s })) })
}

/**
 * Every split whole: each rule's shares make 100%, and each shared amount's
 * parts add up to it to the paisa. Built so by construction; checked here
 * all the same, before anything is saved or posted.
 */
export function wholeProblems(w: WorkedOut): string[] {
  const out: string[] = []
  for (const r of w.rules) {
    if (r.problem || !r.covers) continue
    const total = r.shares.reduce((t, s) => t + s.percent, 0)
    if (Math.abs(total - 100) > 0.000001) out.push(`${r.name}: the shares make ${Math.round(total * 1e6) / 1e6}%, not 100%.`)
  }
  for (const l of w.lines) {
    const parts = r2(l.splits.reduce((t, s) => t + s.amount, 0))
    if (parts !== r2(l.sharedAmount)) out.push(`${l.ledger}${l.department ? ` (${l.department})` : ''}: the brands' parts make ${parts.toFixed(2)}, not ${r2(l.sharedAmount).toFixed(2)}.`)
  }
  return out
}

function refuseProblems(w: WorkedOut) {
  if (w.problems.length) throw new AppError(w.problems.join(' '), 400, 'ALLOCATION_PROBLEM')
  if (!w.lines.length) throw new AppError(`No shared expense in ${w.words} is covered by a rule, so there is nothing to split.`, 400, 'NOTHING_TO_SPLIT')
  const whole = wholeProblems(w)
  if (whole.length) throw new AppError(`The split is not whole: ${whole.join(' ')}`, 400, 'ALLOCATION_NOT_WHOLE')
}

/** A month's run saved as a draft. One live run a month: a second is refused, naming the first. */
export async function createRun(tx: Tx, period: string, inputs: RunInputs, notes: string | null, userId: string | null) {
  const w = await workOut(tx, period, inputs)
  const live = await tx.allocationRun.findFirst({ where: { period, status: { in: ['DRAFT', 'APPROVED', 'POSTED'] } }, select: { runNumber: true, status: true } })
  if (live) throw new AppError(`${w.words} already has ${live.runNumber} (${live.status.toLowerCase()}). Reverse or discard it before running the month again.`, 409, 'RUN_EXISTS')
  refuseProblems(w)
  const s = await booksSettings(tx)
  if (!s.booksStart || w.to < s.booksStart) throw new AppError(`${w.words} is before the books start.`, 400, 'BEFORE_BOOKS')
  if (s.lockedUpTo && w.to <= s.lockedUpTo) throw new AppError(`The books are closed up to ${s.lockedUpTo}: ${w.words} cannot be split now.`, 409, 'PERIOD_LOCKED')
  const date = new Date(`${w.to}T00:00:00Z`)
  await ensureSeries(tx, date)
  const runNumber = await nextDocumentNumber(tx, 'ALC', date)
  const run = await tx.allocationRun.create({ data: { runNumber, period, inputs: inputs as Prisma.InputJsonValue, notes, createdById: userId }, select: { id: true } })
  await writeLines(tx, run.id, w)
  return { id: run.id, runNumber, worked: w }
}

/**
 * A draft — or an approved run not yet posted — worked out again, with what
 * is typed now. An approved one goes back to draft: its figures need
 * approving afresh.
 */
export async function reworkRun(tx: Tx, id: string, inputs: RunInputs | undefined, userId: string | null) {
  const run = await lockRun(tx, id)
  if (run.status !== 'DRAFT' && run.status !== 'APPROVED') throw new AppError(`${run.runNumber} is ${run.status.toLowerCase()}: only a run not yet posted is worked out again.`, 409, 'NOT_DRAFT')
  const use = inputs ?? ((run.inputs ?? {}) as RunInputs)
  const w = await workOut(tx, run.period, use)
  refuseProblems(w)
  await tx.allocationRun.update({
    where: { id },
    data: { status: 'DRAFT', approvedById: null, approvedAt: null, inputs: use as Prisma.InputJsonValue, createdById: userId ?? run.createdById },
  })
  await writeLines(tx, id, w)
  return w
}

/** A run must come out the same when worked out afresh, or expenses changed underneath it. */
async function assertStillTrue(tx: Tx, run: Awaited<ReturnType<typeof lockRun>>) {
  const w = await workOut(tx, run.period, (run.inputs ?? {}) as RunInputs)
  const was = fingerprint(run.lines.map((l) => ({ ledgerId: l.ledgerId, departmentId: l.departmentId, costCentreId: l.costCentreId, amount: Number(l.amount) })))
  if (w.problems.length || fingerprint(flat(w)) !== was) {
    throw new AppError(`Shared expenses in ${w.words} were booked or changed since ${run.runNumber} was worked out. Work it out again, then approve it.`, 409, 'RUN_OUT_OF_DATE')
  }
}

/** Approved by someone other than who worked it out; an Admin may approve their own. */
export async function approveRun(tx: Tx, id: string, userId: string | null, admin = false) {
  const run = await lockRun(tx, id)
  if (run.status !== 'DRAFT') throw new AppError(`${run.runNumber} is ${run.status.toLowerCase()}, not a draft.`, 409, 'NOT_DRAFT')
  if (run.createdById && run.createdById === userId && !admin) {
    throw new AppError(`You worked out ${run.runNumber}, so somebody else approves it.`, 403, 'SELF_APPROVAL')
  }
  await assertStillTrue(tx, run)
  await tx.allocationRun.update({ where: { id }, data: { status: 'APPROVED', approvedById: userId, approvedAt: new Date() } })
  return run
}

export async function discardRun(tx: Tx, id: string, reason: string) {
  const run = await lockRun(tx, id)
  if (run.status !== 'DRAFT' && run.status !== 'APPROVED') throw new AppError(`${run.runNumber} is ${run.status.toLowerCase()}: a posted run is reversed, not discarded.`, 409, 'NOT_DISCARDABLE')
  await tx.allocationRun.update({ where: { id }, data: { status: 'DISCARDED', discardedAt: new Date(), discardReason: reason } })
  return run
}

/** Marks a run posted; the caller posts its journal in the same transaction. */
export async function markPosted(tx: Tx, id: string, userId: string | null) {
  const run = await lockRun(tx, id)
  if (run.status !== 'APPROVED') throw new AppError(`${run.runNumber} is ${run.status.toLowerCase()}: only an approved run is posted.`, 409, 'NOT_APPROVED')
  // Its journal is dated the month's last day: not a day that has not come.
  const { to, words } = monthOf(run.period)
  if (to > todayIst()) throw new AppError(`${words} is not over yet: ${run.runNumber} can be posted from ${dayText(to)}.`, 409, 'MONTH_NOT_OVER')
  await assertStillTrue(tx, run)
  await tx.allocationRun.update({ where: { id }, data: { status: 'POSTED', postedById: userId, postedAt: new Date() } })
  return run
}

/** Marks a run reversed; the caller posts the reversing journal in the same transaction. */
export async function markReversed(tx: Tx, id: string, reason: string, userId: string | null) {
  const run = await lockRun(tx, id)
  if (run.status !== 'POSTED') throw new AppError(`${run.runNumber} is ${run.status.toLowerCase()}: only a posted run is reversed.`, 409, 'NOT_POSTED')
  await tx.allocationRun.update({ where: { id }, data: { status: 'REVERSED', reversedById: userId, reversedAt: new Date(), reverseReason: reason } })
  return run
}

/**
 * A run's journal, as posting.service plans it: for each ledger and
 * department, each brand's share debited and the whole credited with no
 * brand. Reversed, the same lines the other way round.
 */
export async function allocationJournal(tx: Tx, id: string, reversal: boolean) {
  const run = await tx.allocationRun.findUnique({ where: { id }, include: { lines: true } })
  if (!run) return null
  const live = reversal ? run.status === 'REVERSED' : run.status === 'POSTED' || run.status === 'REVERSED'
  if (!live) return null
  const { to, words } = monthOf(run.period)
  const sign = reversal ? -1 : 1
  const lines: Array<{ ledgerId: string; amount: number; costCentreId: string | null; departmentId: string | null }> = []
  const whole = new Map<string, { ledgerId: string; departmentId: string | null; amount: number }>()
  for (const l of run.lines) {
    lines.push({ ledgerId: l.ledgerId, amount: r2(sign * Number(l.amount)), costCentreId: l.costCentreId, departmentId: l.departmentId })
    const k = `${l.ledgerId}|${l.departmentId ?? ''}`
    const w = whole.get(k) ?? { ledgerId: l.ledgerId, departmentId: l.departmentId, amount: 0 }
    w.amount = r2(w.amount + Number(l.amount))
    whole.set(k, w)
  }
  for (const w of whole.values()) lines.push({ ledgerId: w.ledgerId, amount: r2(-sign * w.amount), costCentreId: null, departmentId: w.departmentId })
  return {
    voucherNo: reversal ? `${run.runNumber}-R` : run.runNumber,
    date: to,
    narration: reversal
      ? `Reversal of ${run.runNumber}, the split of ${words}'s shared expenses${run.reverseReason ? ` — ${run.reverseReason}` : ''}`
      : `Shared expenses of ${words} split between the brands (${run.runNumber})`,
    lines,
  }
}

/** A run's posting day: the last day of its month. */
export const runDay = (period: string) => monthOf(period).to
