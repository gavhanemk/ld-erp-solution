import { Router } from 'express'
import { z } from 'zod'
import type { LedgerParty, Prisma, VoucherKind, VoucherState } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { ensureChart } from '../services/accounts/chart.service'
import {
  booksSettings,
  dayValue,
  fyStartOf,
  istDay,
  KIND_LABEL,
  ledgerFigures,
  ledgerStatement,
  openBills,
  periodFrom,
  r2,
  todayIst,
  trialBalance,
} from '../services/accounts/books.service'
import { cancelVoucher, moneyGroupIds, voucherSchema, writeVoucher } from '../services/accounts/voucher.service'
import { pendingDocuments, postPending, SOURCE_LABEL } from '../services/accounts/posting.service'

/**
 * Accounts: the books of LD Cotton Mills.
 *
 *   GET    /summary                  the books' dates and what is in them
 *   PATCH  /settings                 the day the books start, the day they are closed to
 *   GET    /groups                   the group tree
 *   POST   /groups  PATCH/DELETE /groups/:id
 *   GET    /ledgers                  every ledger, with today's balance when asked
 *   GET    /ledgers/:id
 *   POST   /ledgers  PATCH/DELETE /ledgers/:id
 *   GET    /ledgers/:id/statement    the ledger, line by line, for a period
 *   GET    /ledgers/:id/bills        a party's open bills
 *   GET    /cost-centres  POST  PATCH /cost-centres/:id
 *   GET    /vouchers                 the day book
 *   GET    /vouchers/:id
 *   POST   /vouchers  PATCH /vouchers/:id  POST /vouchers/:id/cancel
 *   GET    /trial-balance
 *   GET    /cash-bank                every cash and bank ledger with its balance
 *   GET    /posting                  Sales and Purchase documents not yet in the books
 *   POST   /posting/run              bring them in
 *
 * Everything is under the Accounts module's rights. Lists of ledgers make sure
 * the chart is complete first, so a customer added in Sales has a ledger by
 * the time Accounts is opened.
 */

const router = Router()
const MODULE = 'accounts'
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Not a date')

// ═══════════════════════════════════════════
// THE BOOKS' DATES
// ═══════════════════════════════════════════

router.get('/summary', requirePermission(MODULE, 'view'), async (_req, res) => {
  await ensureChart()
  const s = await booksSettings(prisma)
  const [ledgers, groups, vouchers, costCentres] = await Promise.all([
    prisma.ledger.count(),
    prisma.ledgerGroup.count(),
    prisma.voucher.count({ where: { status: 'POSTED' } }),
    prisma.costCentre.count({ where: { isActive: true } }),
  ])
  res.json({
    success: true,
    data: { ...s, today: todayIst(), fyStart: fyStartOf(todayIst(), s.fyStartMonth), counts: { ledgers, groups, vouchers, costCentres } },
  })
})

const settingsSchema = z.object({
  booksStart: ymd.optional(),
  lockedUpTo: ymd.nullable().optional(),
})

/**
 * PATCH /api/accounts/settings
 *
 * The day the books start can move only while nothing is entered before the
 * new day; the closing date cannot run past today or come before the start.
 */
router.patch('/settings', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const body = settingsSchema.parse(req.body)
  const company = await prisma.company.findFirst({ select: { id: true } })
  if (!company) throw new AppError('Company profile is not set up yet', 409, 'NO_COMPANY')
  const before = await booksSettings(prisma)
  const start = body.booksStart ?? before.booksStart
  if (body.booksStart && body.booksStart !== before.booksStart) {
    // A voucher typed here stays; one written by a document simply leaves the
    // books with it when they start after its date.
    const earlier = await prisma.voucher.findFirst({ where: { status: 'POSTED', sourceType: null, date: { lt: dayValue(body.booksStart) } }, select: { voucherNo: true } })
    if (earlier) throw new AppError(`${earlier.voucherNo} is dated before ${body.booksStart}. The books cannot start after a voucher already in them.`, 409, 'VOUCHERS_BEFORE')
    if (before.lockedUpTo && before.booksStart && before.lockedUpTo >= before.booksStart) {
      throw new AppError('The books are closed. Reopen them before moving the day they start.', 409, 'PERIOD_LOCKED')
    }
  }
  if (body.lockedUpTo) {
    if (body.lockedUpTo > todayIst()) throw new AppError('The books cannot be closed past today.', 400, 'FUTURE_DATE')
    if (!start) throw new AppError('Set the day the books start first.', 400, 'BOOKS_NOT_STARTED')
    if (body.lockedUpTo < start) throw new AppError('The closing date comes before the books start.', 400, 'BEFORE_BOOKS')
    // Once closed, nothing dated in the period can go in, so it all goes in first.
    if (!body.booksStart || body.booksStart === before.booksStart) {
      const waiting = (await pendingDocuments(prisma)).pending.filter((p) => p.date <= body.lockedUpTo!)
      if (waiting.length) {
        throw new AppError(
          `${waiting.length} document${waiting.length === 1 ? ' is' : 's are'} dated on or before ${body.lockedUpTo} and not in the books yet (first: ${waiting[0].number}). Bring them in from the Day Book before closing.`,
          409,
          'DOCUMENTS_WAITING',
        )
      }
    }
  }
  await prisma.company.update({
    where: { id: company.id },
    data: {
      ...(body.booksStart ? { booksStartDate: dayValue(body.booksStart) } : {}),
      ...(body.lockedUpTo !== undefined ? { booksLockedUpTo: body.lockedUpTo ? dayValue(body.lockedUpTo) : null } : {}),
    },
  })
  const after = await booksSettings(prisma)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'BooksSettings', entityId: company.id, before, after })
  // A new start brings the documents from that day into the books, and takes
  // out the ones now before it.
  const posting = after.booksStart !== before.booksStart ? await postPending(prisma, req.user!.id) : null
  res.json({ success: true, data: after, posting })
})

// ═══════════════════════════════════════════
// DOCUMENTS INTO THE BOOKS
// ═══════════════════════════════════════════

/**
 * GET /api/accounts/posting
 *
 * Sales and Purchase documents whose voucher does not match them. Normally
 * empty: every document posts as it is saved. A document saved while a
 * posting rule failed, or one from before this was switched on, shows here.
 */
router.get('/posting', requirePermission(MODULE, 'view'), async (_req, res) => {
  const { booksStart, pending } = await pendingDocuments(prisma)
  res.json({
    success: true,
    data: {
      booksStart,
      count: pending.length,
      pending: pending.slice(0, 500).map((p) => ({ ...p, label: SOURCE_LABEL[p.sourceType] })),
    },
  })
})

/**
 * POST /api/accounts/posting/run { all?: boolean }
 *
 * Posts every waiting document, each on its own, and says which could not
 * be. With `all`, every document in the books' period is posted again.
 */
router.post('/posting/run', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { all } = z.object({ all: z.boolean().optional() }).parse(req.body ?? {})
  const result = await postPending(prisma, req.user!.id, all ?? false)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'BooksPosting', entityId: 'documents', after: { all: !!all, posted: result.posted, failed: result.failed.length } })
  const label = (t: keyof typeof SOURCE_LABEL) => SOURCE_LABEL[t]
  res.json({
    success: true,
    data: { ...result, failed: result.failed.map((f) => ({ ...f, label: label(f.sourceType) })) },
    message: result.failed.length
      ? `${result.posted} brought into the books; ${result.failed.length} could not be.`
      : result.posted
        ? `${result.posted} document${result.posted === 1 ? '' : 's'} brought into the books.`
        : 'Every document is already in the books.',
  })
})

// ═══════════════════════════════════════════
// GROUPS
// ═══════════════════════════════════════════

router.get('/groups', requirePermission(MODULE, 'view'), async (_req, res) => {
  await ensureChart()
  const groups = await prisma.ledgerGroup.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { ledgers: true, children: true } } },
  })
  res.json({ success: true, data: groups })
})

const groupSchema = z.object({
  name: z.string().trim().min(2, 'Give the group a name').max(60),
  parentId: z.string().min(1, 'Say which group it sits under'),
})

/** All the groups under one, itself included. */
async function groupAndBelow(id: string): Promise<Set<string>> {
  const all = await prisma.ledgerGroup.findMany({ select: { id: true, parentId: true } })
  const ids = new Set([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const g of all) {
      if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
        ids.add(g.id)
        grew = true
      }
    }
  }
  return ids
}

/** A group of the mill's own sits under another and takes its nature. */
router.post('/groups', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const body = groupSchema.parse(req.body)
  const parent = await prisma.ledgerGroup.findUnique({ where: { id: body.parentId } })
  if (!parent) throw new AppError('That parent group does not exist', 400, 'NO_GROUP')
  await refuseNameClash('group', body.name)
  const made = await prisma.ledgerGroup.create({
    data: { name: body.name, parentId: parent.id, nature: parent.nature, affectsGrossProfit: parent.affectsGrossProfit, sortOrder: parent.sortOrder + 1 },
  })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'LedgerGroup', entityId: made.id, after: made })
  res.status(201).json({ success: true, data: made })
})

router.patch('/groups/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const body = groupSchema.partial().parse(req.body)
  const group = await prisma.ledgerGroup.findUnique({ where: { id: req.params.id } })
  if (!group) throw new AppError('Group not found', 404, 'NOT_FOUND')
  const data: Prisma.LedgerGroupUpdateInput = {}
  if (body.name && body.name !== group.name) {
    await refuseNameClash('group', body.name, group.id)
    data.name = body.name
  }
  if (body.parentId && body.parentId !== group.parentId) {
    if (group.systemKey) throw new AppError('A standard group stays where it is. Make a group of your own under it instead.', 409, 'SYSTEM_GROUP')
    const parent = await prisma.ledgerGroup.findUnique({ where: { id: body.parentId } })
    if (!parent) throw new AppError('That parent group does not exist', 400, 'NO_GROUP')
    if (parent.nature !== group.nature) throw new AppError(`${group.name} holds ${group.nature.toLowerCase()} ledgers; it cannot move under ${parent.name}.`, 409, 'OTHER_NATURE')
    if ((await groupAndBelow(group.id)).has(parent.id)) throw new AppError('A group cannot sit under one of its own groups', 409, 'GROUP_LOOP')
    data.parent = { connect: { id: parent.id } }
    data.affectsGrossProfit = parent.affectsGrossProfit
  }
  const updated = await prisma.ledgerGroup.update({ where: { id: group.id }, data })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'LedgerGroup', entityId: group.id, before: group, after: updated })
  res.json({ success: true, data: updated })
})

router.delete('/groups/:id', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const group = await prisma.ledgerGroup.findUnique({ where: { id: req.params.id }, include: { _count: { select: { ledgers: true, children: true } } } })
  if (!group) throw new AppError('Group not found', 404, 'NOT_FOUND')
  if (group.systemKey) throw new AppError('A standard group cannot be deleted', 409, 'SYSTEM_GROUP')
  if (group._count.ledgers || group._count.children) {
    throw new AppError(`${group.name} still holds ${group._count.ledgers} ledger(s) and ${group._count.children} group(s). Move them out first.`, 409, 'GROUP_IN_USE')
  }
  await prisma.ledgerGroup.delete({ where: { id: group.id } })
  await writeAuditLog(req, { module: MODULE, action: 'DELETE', entityType: 'LedgerGroup', entityId: group.id, before: group })
  res.json({ success: true })
})

/** Group and ledger names are unique without regard to capitals or spaces at the ends. */
async function refuseNameClash(kind: 'group' | 'ledger', name: string, exceptId?: string) {
  const where = { name: { equals: name.trim(), mode: 'insensitive' as const }, ...(exceptId ? { id: { not: exceptId } } : {}) }
  const clash = kind === 'group' ? await prisma.ledgerGroup.findFirst({ where }) : await prisma.ledger.findFirst({ where })
  if (clash) throw new AppError(`There is already a ${kind} called ${clash.name}`, 409, 'NAME_TAKEN')
}

// ═══════════════════════════════════════════
// LEDGERS
// ═══════════════════════════════════════════

const PARTY_LABEL: Record<LedgerParty, string> = {
  CUSTOMER: 'Customer',
  SUPPLIER: 'Supplier',
  BROKER: 'Broker',
  CONTRACTOR: 'Contractor',
  BANK: 'Bank account',
}

const ledgerSelect = {
  id: true,
  name: true,
  groupId: true,
  group: { select: { id: true, name: true, nature: true, systemKey: true } },
  openingBalance: true,
  billWise: true,
  systemKey: true,
  partyType: true,
  customer: { select: { id: true, code: true } },
  supplier: { select: { id: true, code: true } },
  broker: { select: { id: true, code: true } },
  contractor: { select: { id: true, code: true } },
  bankAccount: { select: { id: true, accountNumber: true, ifscCode: true } },
  pan: true,
  gstin: true,
  notes: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LedgerSelect

type LedgerRow = Prisma.LedgerGetPayload<{ select: typeof ledgerSelect }>

function shapeLedger(l: LedgerRow, money: Set<string>) {
  const master = l.customer ?? l.supplier ?? l.broker ?? l.contractor
  return {
    id: l.id,
    name: l.name,
    groupId: l.groupId,
    group: l.group,
    nature: l.group.nature,
    openingBalance: Number(l.openingBalance),
    billWise: l.billWise,
    systemKey: l.systemKey,
    partyType: l.partyType,
    partyLabel: l.partyType ? PARTY_LABEL[l.partyType] : null,
    partyCode: master?.code ?? null,
    partyId: master?.id ?? l.bankAccount?.id ?? null,
    isMoney: money.has(l.groupId),
    pan: l.pan,
    gstin: l.gstin,
    notes: l.notes,
    isActive: l.isActive,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  }
}

/**
 * GET /api/accounts/ledgers?q=&groupId=&party=&active=1&money=1&balances=1
 *
 * `groupId` takes in the groups under it too. `balances=1` adds each
 * ledger's balance today.
 */
router.get('/ledgers', requirePermission(MODULE, 'view'), async (req, res) => {
  await ensureChart()
  const q = str(req.query.q)
  const where: Prisma.LedgerWhereInput = {}
  if (q) where.name = { contains: q, mode: 'insensitive' }
  if (req.query.active === '1') where.isActive = true
  const party = str(req.query.party)
  if (party === 'none') where.partyType = null
  else if (party) where.partyType = party.toUpperCase() as LedgerParty
  const groupId = str(req.query.groupId)
  if (groupId) where.groupId = { in: [...(await groupAndBelow(groupId))] }
  const [rows, money] = await Promise.all([prisma.ledger.findMany({ where, select: ledgerSelect, orderBy: { name: 'asc' } }), moneyGroupIds(prisma)])
  let data: Array<ReturnType<typeof shapeLedger> & { balance?: number }> = rows.map((l) => shapeLedger(l, money))
  if (req.query.money === '1') data = data.filter((l) => l.isMoney)
  if (req.query.balances === '1') {
    const s = await booksSettings(prisma)
    const today = todayIst()
    const figures = new Map((await ledgerFigures(prisma, { from: fyStartOf(today, s.fyStartMonth), to: today }, s)).map((f) => [f.id, f.closing]))
    data = data.map((l) => ({ ...l, balance: figures.get(l.id) ?? 0 }))
  }
  res.json({ success: true, data })
})

router.get('/ledgers/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const l = await prisma.ledger.findUnique({ where: { id: req.params.id }, select: ledgerSelect })
  if (!l) throw new AppError('Ledger not found', 404, 'NOT_FOUND')
  const used = await prisma.voucherLine.count({ where: { ledgerId: l.id } })
  res.json({ success: true, data: { ...shapeLedger(l, await moneyGroupIds(prisma)), lineCount: used } })
})

const ledgerSchema = z.object({
  name: z.string().trim().min(2, 'Give the ledger a name').max(80),
  groupId: z.string().min(1, 'Say which group it belongs to'),
  /** Signed: debit positive, credit negative. */
  openingBalance: z.number().min(-99_999_999_999).max(99_999_999_999).optional(),
  billWise: z.boolean().optional(),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'That is not a PAN')
    .optional()
    .nullable()
    .or(z.literal('')),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/, 'That is not a GSTIN')
    .optional()
    .nullable()
    .or(z.literal('')),
  notes: z.string().trim().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
})

/** Opening balances are as at the day the books start; once that day is closed they are too. */
async function refuseClosedOpening() {
  const s = await booksSettings(prisma)
  if (s.lockedUpTo && s.booksStart && s.lockedUpTo >= s.booksStart) {
    throw new AppError(`The books are closed up to ${s.lockedUpTo}, which includes the opening balances.`, 409, 'PERIOD_LOCKED')
  }
}

router.post('/ledgers', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const body = ledgerSchema.parse(req.body)
  const group = await prisma.ledgerGroup.findUnique({ where: { id: body.groupId } })
  if (!group) throw new AppError('That group does not exist', 400, 'NO_GROUP')
  await refuseNameClash('ledger', body.name)
  if (body.openingBalance) await refuseClosedOpening()
  const made = await prisma.ledger.create({
    data: {
      name: body.name,
      groupId: group.id,
      openingBalance: r2(body.openingBalance ?? 0),
      billWise: body.billWise ?? false,
      pan: body.pan || null,
      gstin: body.gstin || null,
      notes: body.notes || null,
      isActive: body.isActive ?? true,
      createdById: req.user!.id,
    },
    select: ledgerSelect,
  })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'Ledger', entityId: made.id, after: made })
  res.status(201).json({ success: true, data: shapeLedger(made, await moneyGroupIds(prisma)) })
})

/**
 * PATCH /api/accounts/ledgers/:id
 *
 * A party's ledger is named after its master and follows it; rename the
 * customer or supplier instead. A ledger that stands for a party or that the
 * posting rules use keeps its nature: it may move between groups of the same
 * kind only.
 */
router.patch('/ledgers/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const body = ledgerSchema.partial().parse(req.body)
  const before = await prisma.ledger.findUnique({ where: { id: req.params.id }, select: ledgerSelect })
  if (!before) throw new AppError('Ledger not found', 404, 'NOT_FOUND')
  const data: Prisma.LedgerUpdateInput = {}
  if (body.name !== undefined && body.name !== before.name) {
    if (before.partyType) throw new AppError(`${before.name} is named after its ${PARTY_LABEL[before.partyType].toLowerCase()}. Rename it there.`, 409, 'PARTY_NAME')
    await refuseNameClash('ledger', body.name, before.id)
    data.name = body.name
  }
  if (body.groupId && body.groupId !== before.groupId) {
    const group = await prisma.ledgerGroup.findUnique({ where: { id: body.groupId } })
    if (!group) throw new AppError('That group does not exist', 400, 'NO_GROUP')
    if ((before.systemKey || before.partyType) && group.nature !== before.group.nature) {
      throw new AppError(`${before.name} can only move to another ${before.group.nature.toLowerCase()} group.`, 409, 'OTHER_NATURE')
    }
    data.group = { connect: { id: group.id } }
  }
  if (body.openingBalance !== undefined && r2(body.openingBalance) !== Number(before.openingBalance)) {
    await refuseClosedOpening()
    data.openingBalance = r2(body.openingBalance)
  }
  if (body.billWise !== undefined && body.billWise !== before.billWise) {
    if (!body.billWise && (await prisma.billRef.count({ where: { ledgerId: before.id } }))) {
      throw new AppError(`${before.name} already has bills against it; it stays bill by bill.`, 409, 'HAS_BILLS')
    }
    data.billWise = body.billWise
  }
  if (body.pan !== undefined) data.pan = body.pan || null
  if (body.gstin !== undefined) data.gstin = body.gstin || null
  if (body.notes !== undefined) data.notes = body.notes || null
  if (body.isActive !== undefined && body.isActive !== before.isActive) {
    if (before.partyType) throw new AppError(`${before.name} is switched on and off with its ${PARTY_LABEL[before.partyType].toLowerCase()}.`, 409, 'PARTY_ACTIVE')
    if (before.systemKey && !body.isActive) throw new AppError(`${before.name} is used by the posting rules and stays on.`, 409, 'SYSTEM_LEDGER')
    data.isActive = body.isActive
  }
  const after = await prisma.ledger.update({ where: { id: before.id }, data, select: ledgerSelect })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'Ledger', entityId: before.id, before, after })
  res.json({ success: true, data: shapeLedger(after, await moneyGroupIds(prisma)) })
})

router.delete('/ledgers/:id', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const l = await prisma.ledger.findUnique({ where: { id: req.params.id }, select: ledgerSelect })
  if (!l) throw new AppError('Ledger not found', 404, 'NOT_FOUND')
  if (l.systemKey) throw new AppError(`${l.name} is used by the posting rules and cannot be deleted`, 409, 'SYSTEM_LEDGER')
  if (l.partyType) throw new AppError(`${l.name} belongs to its ${PARTY_LABEL[l.partyType].toLowerCase()} and goes only with it`, 409, 'PARTY_LEDGER')
  const [lines, bills] = await Promise.all([prisma.voucherLine.count({ where: { ledgerId: l.id } }), prisma.billRef.count({ where: { ledgerId: l.id } })])
  if (lines || bills || Number(l.openingBalance)) {
    throw new AppError(`${l.name} has entries or an opening balance. Switch it off instead.`, 409, 'LEDGER_IN_USE')
  }
  await prisma.ledger.delete({ where: { id: l.id } })
  await writeAuditLog(req, { module: MODULE, action: 'DELETE', entityType: 'Ledger', entityId: l.id, before: l })
  res.json({ success: true })
})

router.get('/ledgers/:id/statement', requirePermission(MODULE, 'view'), async (req, res) => {
  const s = await booksSettings(prisma)
  const data = await ledgerStatement(prisma, req.params.id, periodFrom(req.query, s), s)
  res.json({ success: true, data })
})

router.get('/ledgers/:id/bills', requirePermission(MODULE, 'view'), async (req, res) => {
  const except = str(req.query.exceptVoucherId)
  res.json({ success: true, data: await openBills(prisma, req.params.id, except) })
})

// ═══════════════════════════════════════════
// COST CENTRES (BRANDS)
// ═══════════════════════════════════════════

router.get('/cost-centres', requirePermission(MODULE, 'view'), async (_req, res) => {
  await ensureChart()
  const rows = await prisma.costCentre.findMany({ orderBy: { name: 'asc' }, include: { brand: { select: { id: true, name: true } } } })
  res.json({ success: true, data: rows })
})

const centreSchema = z.object({ name: z.string().trim().min(2, 'Give it a name').max(60), isActive: z.boolean().optional() })

router.post('/cost-centres', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const body = centreSchema.parse(req.body)
  const clash = await prisma.costCentre.findFirst({ where: { name: { equals: body.name, mode: 'insensitive' } } })
  if (clash) throw new AppError(`There is already a cost centre called ${clash.name}`, 409, 'NAME_TAKEN')
  const made = await prisma.costCentre.create({ data: { name: body.name, isActive: body.isActive ?? true } })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'CostCentre', entityId: made.id, after: made })
  res.status(201).json({ success: true, data: made })
})

router.patch('/cost-centres/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const body = centreSchema.partial().parse(req.body)
  const before = await prisma.costCentre.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('Cost centre not found', 404, 'NOT_FOUND')
  if (body.name && body.name !== before.name) {
    const clash = await prisma.costCentre.findFirst({ where: { name: { equals: body.name, mode: 'insensitive' }, id: { not: before.id } } })
    if (clash) throw new AppError(`There is already a cost centre called ${clash.name}`, 409, 'NAME_TAKEN')
  }
  if (body.isActive !== undefined && body.isActive !== before.isActive && before.brandId) {
    throw new AppError('A brand’s cost centre is switched on and off with the brand.', 409, 'BRAND_CENTRE')
  }
  const after = await prisma.costCentre.update({ where: { id: before.id }, data: body })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'CostCentre', entityId: before.id, before, after })
  res.json({ success: true, data: after })
})

// ═══════════════════════════════════════════
// VOUCHERS
// ═══════════════════════════════════════════

const KINDS = Object.keys(KIND_LABEL) as VoucherKind[]

/**
 * GET /api/accounts/vouchers?from=&to=&kind=PAYMENT,RECEIPT&status=all&q=&ledgerId=&page=&limit=
 *
 * The day book: every voucher in the period, oldest first within a day, with
 * its lines. From the first of this month unless asked otherwise. Cancelled
 * vouchers are left out unless asked for.
 */
router.get('/vouchers', requirePermission(MODULE, 'view'), async (req, res) => {
  const s = await booksSettings(prisma)
  const today = todayIst()
  const period = periodFrom({ from: req.query.from ?? `${today.slice(0, 8)}01`, to: req.query.to }, s)
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
  const where: Prisma.VoucherWhereInput = {
    date: { gte: new Date(`${period.from}T00:00:00+05:30`), lte: new Date(`${period.to}T23:59:59.999+05:30`) },
  }
  const kinds = (str(req.query.kind) ?? '').split(',').filter((k): k is VoucherKind => KINDS.includes(k as VoucherKind))
  if (kinds.length) where.kind = { in: kinds }
  const status = str(req.query.status)
  if (status === 'cancelled') where.status = 'CANCELLED'
  else if (status !== 'all') where.status = 'POSTED'
  const ledgerId = str(req.query.ledgerId)
  if (ledgerId) where.lines = { some: { ledgerId } }
  const q = str(req.query.q)
  if (q) {
    where.OR = [
      { voucherNo: { contains: q, mode: 'insensitive' } },
      { narration: { contains: q, mode: 'insensitive' } },
      { chequeNo: { contains: q, mode: 'insensitive' } },
      { referenceNo: { contains: q, mode: 'insensitive' } },
      { lines: { some: { ledger: { name: { contains: q, mode: 'insensitive' } } } } },
    ]
  }
  const [rows, total, sums] = await Promise.all([
    prisma.voucher.findMany({
      where,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        kind: true,
        voucherNo: true,
        date: true,
        narration: true,
        amount: true,
        status: true,
        sourceType: true,
        mode: true,
        chequeNo: true,
        referenceNo: true,
        createdBy: { select: { name: true } },
        lines: {
          orderBy: { sortOrder: 'asc' },
          select: { debit: true, credit: true, ledger: { select: { id: true, name: true } }, costCentre: { select: { name: true } } },
        },
      },
    }),
    prisma.voucher.count({ where }),
    prisma.voucher.aggregate({ where: { ...where, status: 'POSTED' }, _sum: { amount: true } }),
  ])
  res.json({
    success: true,
    data: rows.map((v) => ({
      ...v,
      date: istDay(v.date),
      kindLabel: KIND_LABEL[v.kind],
      amount: Number(v.amount),
      lines: v.lines.map((l) => ({ ledgerId: l.ledger.id, ledger: l.ledger.name, debit: Number(l.debit), credit: Number(l.credit), costCentre: l.costCentre?.name ?? null })),
    })),
    period,
    totalAmount: Number(sums._sum.amount ?? 0),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  })
})

const voucherDetail = {
  id: true,
  kind: true,
  voucherNo: true,
  financialYear: true,
  date: true,
  narration: true,
  amount: true,
  mode: true,
  referenceNo: true,
  chequeNo: true,
  chequeDate: true,
  sourceType: true,
  sourceId: true,
  status: true,
  cancelledAt: true,
  cancelReason: true,
  cancelledBy: { select: { name: true } },
  createdAt: true,
  createdBy: { select: { name: true } },
  updatedAt: true,
  updatedBy: { select: { name: true } },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    select: {
      id: true,
      debit: true,
      credit: true,
      narration: true,
      bankDate: true,
      costCentre: { select: { id: true, name: true } },
      ledger: { select: { id: true, name: true, billWise: true, groupId: true, group: { select: { name: true, nature: true } } } },
      billRefs: { select: { kind: true, billNo: true, billDate: true, dueDate: true, amount: true } },
    },
  },
} satisfies Prisma.VoucherSelect

async function loadVoucher(id: string) {
  const v = await prisma.voucher.findUnique({ where: { id }, select: voucherDetail })
  if (!v) throw new AppError('Voucher not found', 404, 'NOT_FOUND')
  return v
}

function shapeVoucher(v: Awaited<ReturnType<typeof loadVoucher>>, money: Set<string>) {
  return {
    ...v,
    date: istDay(v.date),
    chequeDate: v.chequeDate ? istDay(v.chequeDate) : null,
    kindLabel: KIND_LABEL[v.kind],
    amount: Number(v.amount),
    lines: v.lines.map((l) => ({
      id: l.id,
      side: Number(l.debit) > 0 ? ('DR' as const) : ('CR' as const),
      amount: Number(l.debit) > 0 ? Number(l.debit) : Number(l.credit),
      debit: Number(l.debit),
      credit: Number(l.credit),
      narration: l.narration,
      bankDate: l.bankDate ? istDay(l.bankDate) : null,
      costCentre: l.costCentre,
      ledger: { id: l.ledger.id, name: l.ledger.name, billWise: l.ledger.billWise, group: l.ledger.group.name, nature: l.ledger.group.nature, isMoney: money.has(l.ledger.groupId) },
      bills: l.billRefs.map((b) => ({
        kind: b.kind,
        billNo: b.billNo,
        billDate: istDay(b.billDate),
        dueDate: b.dueDate ? istDay(b.dueDate) : null,
        amount: Math.abs(Number(b.amount)),
      })),
    })),
  }
}

/** A voucher, with every change made to it — the edit log the Companies Act asks for. */
router.get('/vouchers/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const [v, money, history] = await Promise.all([
    loadVoucher(req.params.id),
    moneyGroupIds(prisma),
    prisma.auditLog.findMany({
      where: { entityType: 'Voucher', entityId: req.params.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, action: true, createdAt: true, before: true, after: true, user: { select: { name: true } } },
    }),
  ])
  res.json({ success: true, data: { ...shapeVoucher(v, money), history } })
})

router.post('/vouchers', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const input = voucherSchema.parse(req.body)
  await ensureChart()
  const made = await prisma.$transaction((tx) => writeVoucher(tx, input, req.user!.id), { timeout: 30_000 })
  const v = await loadVoucher(made.id)
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'Voucher', entityId: made.id, after: shapeVoucher(v, await moneyGroupIds(prisma)) })
  res.status(201).json({ success: true, data: { id: made.id, voucherNo: made.voucherNo }, message: `${KIND_LABEL[input.kind]} ${made.voucherNo} saved` })
})

/** Alters a voucher typed here. One written by a document changes only with its document. */
router.patch('/vouchers/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const input = voucherSchema.parse(req.body)
  const before = await loadVoucher(req.params.id)
  if (before.status === 'CANCELLED') throw new AppError(`${before.voucherNo} is cancelled and cannot be changed`, 409, 'CANCELLED')
  if (before.sourceType) throw new AppError(`${before.voucherNo} was written by its document. Change the document, and the voucher follows it.`, 409, 'FROM_DOCUMENT')
  const money = await moneyGroupIds(prisma)
  await prisma.$transaction(
    (tx) => writeVoucher(tx, input, req.user!.id, { id: before.id, kind: before.kind, voucherNo: before.voucherNo, financialYear: before.financialYear, date: before.date }),
    { timeout: 30_000 },
  )
  const after = await loadVoucher(before.id)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'Voucher', entityId: before.id, before: shapeVoucher(before, money), after: shapeVoucher(after, money) })
  res.json({ success: true, data: { id: before.id, voucherNo: before.voucherNo }, message: `${before.voucherNo} altered` })
})

router.post('/vouchers/:id/cancel', requirePermission(MODULE, 'delete'), async (req: AuthRequest, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Say why it is being cancelled').max(500) }).parse(req.body)
  const voucherNo = await prisma.$transaction((tx) => cancelVoucher(tx, req.params.id, reason, req.user!.id))
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'Voucher', entityId: req.params.id, after: { status: 'CANCELLED' satisfies VoucherState, reason } })
  res.json({ success: true, message: `${voucherNo} cancelled` })
})

// ═══════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════

router.get('/trial-balance', requirePermission(MODULE, 'view'), async (req, res) => {
  await ensureChart()
  const s = await booksSettings(prisma)
  res.json({ success: true, data: await trialBalance(prisma, periodFrom(req.query, s), s) })
})

/** Cash in hand and every bank, with the balance at the end of the period. */
router.get('/cash-bank', requirePermission(MODULE, 'view'), async (req, res) => {
  await ensureChart()
  const s = await booksSettings(prisma)
  const period = periodFrom(req.query, s)
  const [money, ledgers] = await Promise.all([moneyGroupIds(prisma), ledgerFigures(prisma, period, s)])
  const info = new Map(
    (
      await prisma.ledger.findMany({
        where: { groupId: { in: [...money] } },
        select: { id: true, isActive: true, group: { select: { name: true } }, bankAccount: { select: { accountNumber: true, ifscCode: true, accountType: true } } },
      })
    ).map((l) => [l.id, l]),
  )
  const rows = ledgers
    .filter((l) => info.has(l.id))
    .map((l) => ({ ...l, group: info.get(l.id)!.group.name, isActive: info.get(l.id)!.isActive, bank: info.get(l.id)!.bankAccount }))
    .filter((l) => l.isActive || l.closing !== 0 || l.dr !== 0 || l.cr !== 0)
  res.json({ success: true, data: { period, rows, total: r2(rows.reduce((t, l) => t + l.closing, 0)) } })
})

router.get('/gst', () => {
  throw new AppError('GST returns are not built yet. They will appear here as soon as they are ready.', 501, 'NOT_IMPLEMENTED')
})

export default router
