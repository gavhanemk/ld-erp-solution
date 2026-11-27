import { Router } from 'express'
import { z } from 'zod'
import type { AllocationBasis, Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { isAdmin, requirePermission, type AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { createOnce, requestIdOf } from '../lib/onceFor'
import { ensureChart } from '../services/accounts/chart.service'
import { postDocument } from '../services/accounts/posting.service'
import { istDay, r2 } from '../services/accounts/books.service'
import {
  approveRun,
  BASIS_WORDS,
  createRun,
  discardRun,
  markPosted,
  markReversed,
  monthOf,
  reworkRun,
  TYPED_BASES,
  workOut,
  type RunInputs,
} from '../services/accounts/allocation.service'

/**
 * Accounts → Expense Allocation: the rules that split shared expenses between
 * the brands, and each month's run of them — worked out, approved, posted
 * as one journal, and reversed if it must be done again.
 */
const router = Router()
const MODULE = 'accounts'

const BASES = Object.keys(BASIS_WORDS) as [AllocationBasis, ...AllocationBasis[]]
const period = z.string().regex(/^\d{4}-\d{2}$/, 'Say which month, as 2026-11')
const inputsSchema = z.record(z.string(), z.record(z.string(), z.number().min(0).max(1_000_000_000))).default({})
const reason = z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(500) })

/** The own brands' profit centres a rule may share between. */
const brandCentres = (db: Prisma.TransactionClient | typeof prisma) =>
  db.costCentre.findMany({
    where: { isActive: true, brand: { isActive: true, type: { not: 'CUSTOM' } } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

/** Expense ledgers that can be shared: every expense ledger except stock purchases. */
async function sharableLedgers(db: Prisma.TransactionClient | typeof prisma) {
  const groups = await db.ledgerGroup.findMany({ select: { id: true, name: true, parentId: true, systemKey: true, nature: true } })
  const byId = new Map(groups.map((g) => [g.id, g]))
  const top = (id: string) => {
    let g = byId.get(id)
    for (let i = 0; g?.parentId && i < 20; i++) g = byId.get(g.parentId)
    return g?.systemKey ?? null
  }
  const ledgers = await db.ledger.findMany({
    where: { isActive: true, group: { nature: 'EXPENSE' } },
    select: { id: true, name: true, groupId: true, systemKey: true },
    orderBy: { name: 'asc' },
  })
  return ledgers
    .filter((l) => top(l.groupId) !== 'PURCHASE_ACCOUNTS' && l.systemKey !== 'ROUND_OFF')
    .map((l) => ({ id: l.id, name: l.name, group: byId.get(l.groupId)?.name ?? '' }))
}

// ═══════════════════════════════════════════
// OVERVIEW
// ═══════════════════════════════════════════

const runSelect = {
  id: true,
  runNumber: true,
  period: true,
  status: true,
  notes: true,
  inputs: true,
  createdAt: true,
  approvedAt: true,
  postedAt: true,
  reversedAt: true,
  reverseReason: true,
  discardedAt: true,
  discardReason: true,
  createdBy: { select: { name: true } },
  approvedBy: { select: { name: true } },
  postedBy: { select: { name: true } },
  reversedBy: { select: { name: true } },
} satisfies Prisma.AllocationRunSelect

/**
 * GET /api/accounts/allocation
 * The rules, every run, and what the rule form picks from.
 */
router.get('/', requirePermission(MODULE, 'view'), async (_req: AuthRequest, res) => {
  const [rules, runs, totals, centres, ledgers, departments, used] = await Promise.all([
    prisma.allocationRule.findMany({ include: { shares: true }, orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.allocationRun.findMany({ select: runSelect, orderBy: [{ period: 'desc' }, { createdAt: 'desc' }], take: 200 }),
    prisma.allocationRunLine.groupBy({ by: ['runId'], _sum: { amount: true } }),
    brandCentres(prisma),
    sharableLedgers(prisma),
    prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.allocationRunLine.groupBy({ by: ['ruleId'], _count: { _all: true } }),
  ])
  const ledgerName = new Map(ledgers.map((l) => [l.id, l.name]))
  const deptName = new Map(departments.map((d) => [d.id, d.name]))
  const centreName = new Map(centres.map((c) => [c.id, c.name]))
  const allCentres = await prisma.costCentre.findMany({ select: { id: true, name: true } })
  for (const c of allCentres) if (!centreName.has(c.id)) centreName.set(c.id, c.name)
  const allLedgers = await prisma.ledger.findMany({ where: { id: { in: [...new Set(rules.flatMap((r) => r.ledgerIds))] } }, select: { id: true, name: true } })
  for (const l of allLedgers) if (!ledgerName.has(l.id)) ledgerName.set(l.id, l.name)
  const allDepts = await prisma.department.findMany({ where: { id: { in: [...new Set(rules.flatMap((r) => r.departmentIds))] } }, select: { id: true, name: true } })
  for (const d of allDepts) if (!deptName.has(d.id)) deptName.set(d.id, d.name)

  res.json({
    success: true,
    data: {
      rules: rules.map((r) => ({
        id: r.id,
        name: r.name,
        basis: r.basis,
        basisWords: BASIS_WORDS[r.basis],
        typed: TYPED_BASES.includes(r.basis),
        ledgers: r.ledgerIds.map((id) => ({ id, name: ledgerName.get(id) ?? '(removed)' })),
        departments: r.departmentIds.map((id) => ({ id, name: deptName.get(id) ?? '(removed)' })),
        brands: r.costCentreIds.map((id) => ({ id, name: centreName.get(id) ?? '(removed)' })),
        shares: r.shares.map((s) => ({ costCentreId: s.costCentreId, name: centreName.get(s.costCentreId) ?? '', percent: Number(s.percent) })),
        sortOrder: r.sortOrder,
        isActive: r.isActive,
        notes: r.notes,
        usedInRuns: used.find((u) => u.ruleId === r.id)?._count._all ?? 0,
      })),
      runs: runs.map((r) => ({ ...shapeRun(r), allocated: r2(Number(totals.find((t) => t.runId === r.id)?._sum.amount ?? 0)) })),
      brands: centres,
      ledgers,
      departments,
      bases: BASES.map((b) => ({ value: b, label: BASIS_WORDS[b], typed: TYPED_BASES.includes(b) })),
    },
  })
})

function shapeRun(r: Prisma.AllocationRunGetPayload<{ select: typeof runSelect }>) {
  let words = r.period
  try {
    words = monthOf(r.period).words
  } catch {
    /* a month not yet begun cannot have a run; keep the bare period */
  }
  return {
    id: r.id,
    runNumber: r.runNumber,
    period: r.period,
    words,
    status: r.status,
    notes: r.notes,
    inputs: (r.inputs ?? {}) as RunInputs,
    createdBy: r.createdBy?.name ?? null,
    createdAt: r.createdAt,
    approvedBy: r.approvedBy?.name ?? null,
    approvedAt: r.approvedAt,
    postedBy: r.postedBy?.name ?? null,
    postedAt: r.postedAt,
    reversedBy: r.reversedBy?.name ?? null,
    reversedAt: r.reversedAt,
    reverseReason: r.reverseReason,
    discardedAt: r.discardedAt,
    discardReason: r.discardReason,
  }
}

// ═══════════════════════════════════════════
// PREVIEW AND RUNS
// ═══════════════════════════════════════════

/**
 * POST /api/accounts/allocation/preview { period, inputs }
 * The month worked out, nothing saved — and the month's live run, if it has one.
 */
router.post('/preview', requirePermission(MODULE, 'view'), async (req: AuthRequest, res) => {
  const body = z.object({ period, inputs: inputsSchema }).parse(req.body)
  const worked = await prisma.$transaction((tx) => workOut(tx, body.period, body.inputs), { timeout: 60_000 })
  const live = await prisma.allocationRun.findFirst({ where: { period: body.period, status: { in: ['DRAFT', 'APPROVED', 'POSTED'] } }, select: { id: true, runNumber: true, status: true } })
  res.json({ success: true, data: { ...worked, live } })
})

/**
 * GET /api/accounts/allocation/runs/:id
 * A run as saved — its splits, the expenses it took, its journals — and
 * whether the month's shared expenses have changed since it was worked out.
 */
router.get('/runs/:id', requirePermission(MODULE, 'view'), async (req: AuthRequest, res) => {
  const run = await prisma.allocationRun.findUnique({
    where: { id: req.params.id },
    select: {
      ...runSelect,
      lines: { include: { rule: { select: { name: true, basis: true } }, ledger: { select: { name: true } }, department: { select: { name: true } }, costCentre: { select: { name: true } } } },
      sources: true,
    },
  })
  if (!run) throw new AppError('That allocation run does not exist', 404, 'NOT_FOUND')

  // Grouped as the screen reads it: each shared amount, then each brand's part.
  const groups = new Map<string, { ledger: string; department: string | null; rule: string; basis: string; sharedAmount: number; splits: Array<{ brand: string; basisValue: number; percent: number; amount: number }> }>()
  for (const l of run.lines) {
    const k = `${l.ledgerId}|${l.departmentId ?? ''}`
    const g = groups.get(k) ?? { ledger: l.ledger.name, department: l.department?.name ?? null, rule: l.rule.name, basis: BASIS_WORDS[l.rule.basis], sharedAmount: Number(l.sharedAmount), splits: [] }
    g.splits.push({ brand: l.costCentre.name, basisValue: Number(l.basisValue), percent: Number(l.percent), amount: Number(l.amount) })
    groups.set(k, g)
  }
  const byBrand = new Map<string, number>()
  for (const l of run.lines) byBrand.set(l.costCentre.name, r2((byBrand.get(l.costCentre.name) ?? 0) + Number(l.amount)))

  const vouchers = await prisma.voucher.findMany({
    where: { sourceId: run.id, sourceType: { in: ['EXPENSE_ALLOCATION', 'EXPENSE_ALLOCATION_REVERSAL'] } },
    select: { id: true, voucherNo: true, sourceType: true, date: true, amount: true, status: true },
  })
  const [voucherNos, srcLedgers, srcDepts] = await Promise.all([
    prisma.voucher.findMany({ where: { id: { in: [...new Set(run.sources.map((s) => s.voucherId))] } }, select: { id: true, voucherNo: true, date: true, narration: true, sourceType: true } }),
    prisma.ledger.findMany({ where: { id: { in: [...new Set(run.sources.map((s) => s.ledgerId))] } }, select: { id: true, name: true } }),
    prisma.department.findMany({ where: { id: { in: [...new Set(run.sources.flatMap((s) => (s.departmentId ? [s.departmentId] : [])))] } }, select: { id: true, name: true } }),
  ])
  const vno = new Map(voucherNos.map((v) => [v.id, v]))
  const ledgerOf = new Map(srcLedgers.map((l) => [l.id, l.name]))
  const deptOf = new Map(srcDepts.map((d) => [d.id, d.name]))

  // Still what the month says? A live run is checked against a fresh working-out.
  let outOfDate = false
  if (run.status === 'DRAFT' || run.status === 'APPROVED' || run.status === 'POSTED') {
    const fresh = await prisma.$transaction((tx) => workOut(tx, run.period, (run.inputs ?? {}) as RunInputs), { timeout: 60_000 })
    const print = (rows: Array<{ ledgerId: string; departmentId: string | null; costCentreId: string; amount: number }>) =>
      rows.map((x) => `${x.ledgerId}|${x.departmentId ?? ''}|${x.costCentreId}|${r2(x.amount).toFixed(2)}`).sort().join(';')
    const now = print(fresh.lines.flatMap((l) => l.splits.map((s) => ({ ledgerId: l.ledgerId, departmentId: l.departmentId, costCentreId: s.costCentreId, amount: s.amount }))))
    const was = print(run.lines.map((l) => ({ ledgerId: l.ledgerId, departmentId: l.departmentId, costCentreId: l.costCentreId, amount: Number(l.amount) })))
    outOfDate = fresh.problems.length > 0 || now !== was
  }

  res.json({
    success: true,
    data: {
      ...shapeRun(run),
      outOfDate,
      lines: [...groups.values()].sort((a, b) => b.sharedAmount - a.sharedAmount),
      byBrand: [...byBrand.entries()].map(([brand, amount]) => ({ brand, amount })).sort((a, b) => b.amount - a.amount),
      total: r2(run.lines.reduce((t, l) => t + Number(l.amount), 0)),
      sources: run.sources
        .map((s) => ({
          voucherId: s.voucherId,
          voucherNo: vno.get(s.voucherId)?.voucherNo ?? '',
          date: vno.get(s.voucherId) ? istDay(vno.get(s.voucherId)!.date) : null,
          narration: vno.get(s.voucherId)?.narration ?? null,
          ledger: ledgerOf.get(s.ledgerId) ?? '',
          department: s.departmentId ? (deptOf.get(s.departmentId) ?? '') : null,
          amount: Number(s.amount),
        }))
        .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.voucherNo.localeCompare(b.voucherNo)),
      vouchers: vouchers.map((v) => ({ id: v.id, voucherNo: v.voucherNo, reversal: v.sourceType === 'EXPENSE_ALLOCATION_REVERSAL', date: istDay(v.date), amount: Number(v.amount), status: v.status })),
    },
  })
})

/** A second live run of a month is refused by the database too, if two arrive at once. */
const isOneLiveClash = (e: unknown) => {
  const err = e as { code?: string; message?: string; meta?: { target?: unknown } }
  return err?.code === 'P2002' && /period|one_live/.test(`${JSON.stringify(err.meta?.target ?? '')} ${err.message ?? ''}`)
}

/**
 * POST /api/accounts/allocation/runs { period, inputs, notes, requestId }
 * The month saved as a draft run. One live run a month.
 */
router.post('/runs', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const body = z.object({ period, inputs: inputsSchema, notes: z.string().trim().max(500).optional().nullable() }).parse(req.body)
  await ensureChart()
  let made: { id: string; runNumber: string }
  let repeat: boolean
  try {
    ;({ doc: made, repeat } = await createOnce({
      requestId: requestIdOf(req.body),
      kind: 'ALLOCATION_RUN',
      userId: req.user!.id,
      make: async (tx) => {
        const r = await createRun(tx, body.period, body.inputs, body.notes || null, req.user!.id)
        return { id: r.id, runNumber: r.runNumber }
      },
      load: (id) => prisma.allocationRun.findUniqueOrThrow({ where: { id }, select: { id: true, runNumber: true } }),
      timeout: 60_000,
    }))
  } catch (e) {
    if (isOneLiveClash(e)) throw new AppError('That month already has a live run: another was saved at the same moment. Reload to see it.', 409, 'RUN_EXISTS')
    throw e
  }
  if (!repeat) await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'AllocationRun', entityId: made.id, after: { runNumber: made.runNumber, period: body.period, inputs: body.inputs } })
  res.status(repeat ? 200 : 201).json({ success: true, data: made, message: `${made.runNumber} saved as a draft${repeat ? '. (That was the same request again: nothing more was saved.)' : ''}`, repeat })
})

/** POST /api/accounts/allocation/runs/:id/rework { inputs? } — a draft worked out again. */
router.post('/runs/:id/rework', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const body = z.object({ inputs: inputsSchema.optional() }).parse(req.body ?? {})
  const w = await prisma.$transaction((tx) => reworkRun(tx, req.params.id, body.inputs, req.user!.id), { timeout: 60_000 })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'AllocationRun', entityId: req.params.id, after: { reworked: true, allocated: w.totals.allocated } })
  res.json({ success: true, data: { allocated: w.totals.allocated }, message: 'Worked out again' })
})

/** POST /api/accounts/allocation/runs/:id/approve */
router.post('/runs/:id/approve', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const run = await prisma.$transaction((tx) => approveRun(tx, req.params.id, req.user!.id, isAdmin(req.user)), { timeout: 60_000 })
  await writeAuditLog(req, { module: MODULE, action: 'APPROVE', entityType: 'AllocationRun', entityId: run.id, after: { runNumber: run.runNumber, status: 'APPROVED' } })
  res.json({ success: true, message: `${run.runNumber} approved` })
})

/** POST /api/accounts/allocation/runs/:id/post — its journal written into the books. */
router.post('/runs/:id/post', requirePermission(MODULE, 'post'), async (req: AuthRequest, res) => {
  await ensureChart()
  const run = await prisma.$transaction(
    async (tx) => {
      const r = await markPosted(tx, req.params.id, req.user!.id)
      const result = await postDocument(tx, 'EXPENSE_ALLOCATION', r.id, req.user!.id)
      if (result !== 'created' && result !== 'updated' && result !== 'unchanged') {
        throw new AppError(`${r.runNumber} could not be written into the books (${result}). Check the books' start date.`, 409, 'NOT_POSTED')
      }
      return r
    },
    { timeout: 60_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'APPROVE', entityType: 'AllocationRun', entityId: run.id, after: { runNumber: run.runNumber, status: 'POSTED' } })
  res.json({ success: true, message: `${run.runNumber} posted: journal ${run.runNumber} is in the books` })
})

/** POST /api/accounts/allocation/runs/:id/reverse { reason } — a reversing journal; the month may run again. */
router.post('/runs/:id/reverse', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const { reason: why } = reason.parse(req.body)
  const run = await prisma.$transaction(
    async (tx) => {
      const r = await markReversed(tx, req.params.id, why, req.user!.id)
      const result = await postDocument(tx, 'EXPENSE_ALLOCATION_REVERSAL', r.id, req.user!.id)
      if (result !== 'created' && result !== 'updated' && result !== 'unchanged') {
        throw new AppError(`The reversal of ${r.runNumber} could not be written into the books (${result}).`, 409, 'NOT_POSTED')
      }
      return r
    },
    { timeout: 60_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'AllocationRun', entityId: run.id, after: { runNumber: run.runNumber, status: 'REVERSED', reason: why } })
  res.json({ success: true, message: `${run.runNumber} reversed by journal ${run.runNumber}-R. The month can be run again.` })
})

/** POST /api/accounts/allocation/runs/:id/discard { reason } — a draft or approved run set aside, its number kept. */
router.post('/runs/:id/discard', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const { reason: why } = reason.parse(req.body)
  const run = await prisma.$transaction((tx) => discardRun(tx, req.params.id, why), { timeout: 30_000 })
  await writeAuditLog(req, { module: MODULE, action: 'DELETE', entityType: 'AllocationRun', entityId: run.id, before: { runNumber: run.runNumber, status: run.status }, after: { status: 'DISCARDED', reason: why } })
  res.json({ success: true, message: `${run.runNumber} discarded` })
})

// ═══════════════════════════════════════════
// RULES
// ═══════════════════════════════════════════

export const ruleSchema = z.object({
  name: z.string().trim().min(2, 'Give the rule a name').max(80),
  basis: z.enum(BASES),
  ledgerIds: z.array(z.string().min(1)).max(300).default([]),
  departmentIds: z.array(z.string().min(1)).max(200).default([]),
  costCentreIds: z.array(z.string().min(1)).max(50).default([]),
  shares: z.array(z.object({ costCentreId: z.string().min(1), percent: z.number().min(0).max(100) })).max(50).default([]),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
  notes: z.string().trim().max(500).optional().nullable(),
})

/** A rule names only shared expense ledgers, departments in use and own brands; fixed shares make 100%. */
export async function checkRule(tx: Prisma.TransactionClient, r: z.infer<typeof ruleSchema>) {
  const ledgers = new Set((await sharableLedgers(tx)).map((l) => l.id))
  const badLedger = r.ledgerIds.filter((id) => !ledgers.has(id))
  if (badLedger.length) {
    const names = await tx.ledger.findMany({ where: { id: { in: badLedger } }, select: { name: true } })
    throw new AppError(`${names.map((n) => n.name).join(', ') || 'A ledger'} cannot be shared: only expense ledgers in use, and not stock purchases, which stay central until the stock moves to a brand.`, 400, 'BAD_LEDGER')
  }
  if (r.departmentIds.length) {
    const found = await tx.department.count({ where: { id: { in: r.departmentIds }, isActive: true } })
    if (found !== new Set(r.departmentIds).size) throw new AppError('A department on the rule is not in use.', 400, 'BAD_DEPARTMENT')
  }
  const own = new Set((await brandCentres(tx)).map((c) => c.id))
  if (r.costCentreIds.some((id) => !own.has(id))) throw new AppError('A rule shares only between own brands in use (not customer brands).', 400, 'BAD_BRAND')
  const allowed = r.costCentreIds.length ? new Set(r.costCentreIds) : own
  if (r.basis === 'FIXED_PERCENT') {
    if (!r.shares.length) throw new AppError('Give each brand its percentage.', 400, 'SHARES_NEEDED')
    if (r.shares.some((s) => !allowed.has(s.costCentreId))) throw new AppError('A percentage is given to a brand the rule does not share between.', 400, 'BAD_BRAND')
    if (new Set(r.shares.map((s) => s.costCentreId)).size !== r.shares.length) throw new AppError('A brand is given two percentages.', 400, 'BAD_SHARES')
    const total = Math.round(r.shares.reduce((t, s) => t + s.percent, 0) * 1e4) / 1e4
    if (total !== 100) throw new AppError(`The percentages make ${total}%. They must make exactly 100%.`, 400, 'NOT_100')
  }
}

const ruleData = (r: z.infer<typeof ruleSchema>) => ({
  name: r.name,
  basis: r.basis,
  ledgerIds: [...new Set(r.ledgerIds)],
  departmentIds: [...new Set(r.departmentIds)],
  costCentreIds: [...new Set(r.costCentreIds)],
  sortOrder: r.sortOrder,
  isActive: r.isActive,
  notes: r.notes || null,
})

const sharesOf = (r: z.infer<typeof ruleSchema>) => (r.basis === 'FIXED_PERCENT' ? r.shares.filter((s) => s.percent > 0) : [])

const nameTaken = (e: unknown) => (e as { code?: string })?.code === 'P2002'

/** POST /api/accounts/allocation/rules */
router.post('/rules', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const r = ruleSchema.parse(req.body)
  const made = await prisma
    .$transaction(async (tx) => {
      await checkRule(tx, r)
      return tx.allocationRule.create({ data: { ...ruleData(r), createdById: req.user!.id, shares: { create: sharesOf(r) } }, select: { id: true, name: true } })
    })
    .catch((e) => {
      if (nameTaken(e)) throw new AppError(`There is already a rule called ${r.name}.`, 409, 'NAME_TAKEN')
      throw e
    })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'AllocationRule', entityId: made.id, after: r })
  res.status(201).json({ success: true, data: made, message: `Rule ${made.name} saved` })
})

/** PATCH /api/accounts/allocation/rules/:id — a draft worked out under the old rule is then out of date. */
router.patch('/rules/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const r = ruleSchema.parse(req.body)
  const before = await prisma.allocationRule.findUnique({ where: { id: req.params.id }, include: { shares: true } })
  if (!before) throw new AppError('That rule does not exist', 404, 'NOT_FOUND')
  await prisma
    .$transaction(async (tx) => {
      await checkRule(tx, r)
      await tx.allocationRuleShare.deleteMany({ where: { ruleId: before.id } })
      await tx.allocationRule.update({ where: { id: before.id }, data: { ...ruleData(r), shares: { create: sharesOf(r) } } })
    })
    .catch((e) => {
      if (nameTaken(e)) throw new AppError(`There is already a rule called ${r.name}.`, 409, 'NAME_TAKEN')
      throw e
    })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'AllocationRule', entityId: before.id, before, after: r })
  res.json({ success: true, message: `Rule ${r.name} saved` })
})

/** DELETE /api/accounts/allocation/rules/:id — only a rule no run has used; a used one is switched off. */
router.delete('/rules/:id', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const rule = await prisma.allocationRule.findUnique({ where: { id: req.params.id }, include: { shares: true } })
  if (!rule) throw new AppError('That rule does not exist', 404, 'NOT_FOUND')
  const used = await prisma.allocationRunLine.count({ where: { ruleId: rule.id } })
  if (used) throw new AppError(`${rule.name} has split expenses in earlier runs, so it stays on record. Switch it off instead.`, 409, 'RULE_USED')
  await prisma.allocationRule.delete({ where: { id: rule.id } })
  await writeAuditLog(req, { module: MODULE, action: 'DELETE', entityType: 'AllocationRule', entityId: rule.id, before: rule })
  res.json({ success: true, message: `Rule ${rule.name} deleted` })
})

export default router
