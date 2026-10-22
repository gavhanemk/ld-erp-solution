import { Router } from 'express'
import type { Prisma, TransferStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, userCan, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { getPrintHeader } from '../lib/printData'
import { applyRouting, editRoute, editRouteSchema, passedBy, restoreStep, routeStepSchema, routingsFor, skipStep } from '../services/route.service'
import {
  billSchema,
  cancelTransfer,
  closeJobWorkOrder,
  decide,
  decideSchema,
  destinationsOf,
  dispatch,
  dispatchSchema,
  holdMo,
  receive,
  receiveSchema,
  recordWork,
  resumeMo,
  reworkDone,
  reworkDoneSchema,
  sendBack,
  sendBackSchema,
  setReturnBill,
  settleSchema,
  settleShort,
  undoEvent,
  vendorReturn,
  vendorReturnSchema,
  workSchema,
} from '../services/floor.service'
import { flowSummary } from '../services/floorView.service'
import { processCode } from '../services/challanNo'
import { stageReport } from '../services/stageReport.service'
import { balancesOf } from '../services/wip.service'
import { createCutting, cuttingContractors, cuttingSchema, cutterIssueSchema, issueToCutter } from '../services/cutting.service'
import { boardCards, ensureJobCards, fillJobCardBlanks, jobCardDetail, jobCardSchema, listJobCards, stageSheets, stageTabs, STAGES, updateJobCard, type Stage } from '../services/jobCard.service'

/**
 * The floor: an order's stages, its job cards and their department sheets
 * (cutting, stitching, other processes, checks), the transfer cards between
 * departments, the work recorded at each step, and job work orders for steps
 * done outside. Mounted beside production.routes under /api/production.
 *
 * Recording what moved — sending, counting in, work done, a return from a
 * unit — needs production:create, which the floor desks have. Settling a
 * shortfall, deciding on damaged pieces, undoing an entry and changing a
 * route need production:edit; writing pieces off, passing rejects as they
 * are, leaving out a required step and changing a released order's route
 * need production:approve as well.
 */

const router = Router()
const MODULE = 'production'
const T = { timeout: 60_000, maxWait: 20_000 }

const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(500) })
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const mayApprove = (req: AuthRequest) => userCan(req.user, MODULE, 'approve')
const pcs = (n: number) => n.toLocaleString('en-IN')

// ─── Route ────────────────────────────────────────────────────

/** GET /routings/for?styleIds=a,b — the routings an order with these styles could take, best fit first. */
router.get('/routings/for', requirePermission(MODULE, 'view'), async (req, res) => {
  const ids = String(req.query.styleIds ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!ids.length) throw new AppError('Say which styles', 400, 'NO_STYLES')
  res.json({ success: true, data: await routingsFor(prisma, ids) })
})

/**
 * POST /orders/:id/routing — gives an order a routing's steps, while nothing
 * has been cut on it. With `steps`, the routing's stages as changed for this
 * order in the same window: loaded, then set to these, in one go.
 */
router.post('/orders/:id/routing', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { routingId, steps } = z
    .object({ routingId: z.string().min(1, 'Pick a routing'), steps: z.array(routeStepSchema).min(1).max(60).optional() })
    .parse(req.body)
  const routing = await prisma.$transaction(async (tx) => {
    const mo = await tx.manufacturingOrder.findUnique({ where: { id: req.params.id }, select: { moNumber: true, status: true } })
    if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
    if (mo.status === 'CLOSED' || mo.status === 'COMPLETED') throw new AppError(`${mo.moNumber} is ${mo.status.toLowerCase()}.`, 409, 'NOT_OPEN')
    const oldCuts = await tx.cuttingOrder.count({ where: { moId: req.params.id, status: { not: 'CANCELLED' }, bundles: { none: {} } } })
    if (oldCuts) {
      throw new AppError(`Pieces were cut on ${mo.moNumber} before it had a route, without bundles. It carries on as it is; new orders take a route.`, 409, 'CUT_WITHOUT_ROUTE')
    }
    // Production starts once the materials are with the floor: the stages
    // are loaded after the store has issued them.
    if (mo.status !== 'DRAFT') {
      const issued = await tx.materialRequisitionLine.count({ where: { mr: { moId: req.params.id }, issuedQty: { gt: 0 } } })
      if (!issued) throw new AppError(`${mo.moNumber}'s materials have not been issued yet. Raise its requisition and have the store issue it, then load the stages.`, 409, 'MATERIALS_NOT_ISSUED')
    }
    const routing = await applyRouting(tx, req.params.id, routingId)
    // Changed for this order before loading: nothing has moved yet, so every step is written as given.
    if (steps) await editRoute(tx, req.params.id, { steps: steps.map((s) => ({ ...s, id: null })), reason: `Set for ${mo.moNumber} when its stages were loaded` })
    if (mo.status !== 'DRAFT') await ensureJobCards(tx, req.params.id)
    const names = (await tx.mOStep.findMany({ where: { moId: req.params.id }, orderBy: { sequence: 'asc' }, select: { name: true } })).map((s) => s.name)
    return { routing, names }
  }, T)
  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'ManufacturingOrder',
    entityId: req.params.id,
    after: { routingId, routing: routing.routing.code, route: routing.names, changed: !!steps },
  })
  res.json({
    success: true,
    message: `Stages set: ${routing.names.join(' → ')}${steps ? ` (from ${routing.routing.code}, changed for this order)` : ` (from ${routing.routing.code})`}. Each colour's process sheets are ready, starting with cutting.`,
  })
})

/** PATCH /orders/:id/route — this order's own route changed, ahead of the pieces. */
router.patch('/orders/:id/route', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = editRouteSchema.parse(req.body)
  const mo = await prisma.manufacturingOrder.findUnique({ where: { id: req.params.id }, select: { moNumber: true, status: true, steps: { orderBy: { sequence: 'asc' }, select: { name: true } } } })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  if (mo.status === 'CLOSED') throw new AppError(`${mo.moNumber} is closed.`, 409, 'NOT_OPEN')
  if (mo.status !== 'DRAFT' && !mayApprove(req)) throw new AppError(`${mo.moNumber} is on the floor: changing its route needs a production manager.`, 403, 'NEEDS_APPROVAL')
  const out = await prisma.$transaction((tx) => editRoute(tx, req.params.id, data), T)
  const after = await prisma.mOStep.findMany({ where: { moId: req.params.id }, orderBy: { sequence: 'asc' }, select: { name: true } })
  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'ManufacturingOrder',
    entityId: req.params.id,
    before: { route: mo.steps.map((s) => s.name) },
    after: { route: after.map((s) => s.name), reason: data.reason },
  })
  res.json({ success: true, message: `${mo.moNumber}'s route is now ${after.map((s) => s.name).join(' → ')}.${out.fixed.length ? ` ${out.fixed.join(', ')} stayed as ${out.fixed.length === 1 ? 'it was' : 'they were'}: pieces have been through.` : ''}` })
})

router.post('/orders/:id/steps/:stepId/skip', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const step = await prisma.$transaction((tx) => skipStep(tx, req.params.id, req.params.stepId, reason, { userId: req.user!.id, mayApprove: mayApprove(req) }), T)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'MOStep', entityId: step.id, after: step })
  res.json({ success: true, message: `${step.name} left out of the route: pieces now go past it. Anything already there finishes as normal.` })
})

router.post('/orders/:id/steps/:stepId/restore', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const step = await prisma.$transaction((tx) => restoreStep(tx, req.params.id, req.params.stepId, { mayApprove: mayApprove(req) }), T)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'MOStep', entityId: step.id, after: step })
  res.json({ success: true, message: `${step.name} is back on the route.` })
})

router.post('/orders/:id/hold', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const mo = await prisma.$transaction((tx) => holdMo(tx, req.params.id, reason, req.user!.id), T)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: mo.id, after: { heldAt: mo.heldAt, holdReason: reason } })
  res.json({ success: true, message: `${mo.moNumber} is on hold: nothing moves on the floor for it until it is resumed.` })
})

router.post('/orders/:id/resume', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const mo = await prisma.$transaction((tx) => resumeMo(tx, req.params.id), T)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: mo.id, after: { heldAt: null } })
  res.json({ success: true, message: `${mo.moNumber} resumed.` })
})

/** GET /orders/:id/flow — the route with each step's figures, the bundles, cards and job work. */
router.get('/orders/:id/flow', requirePermission(MODULE, 'view'), async (req, res) => {
  res.json({ success: true, data: await flowSummary(prisma, req.params.id) })
})

// ─── Transfer cards ───────────────────────────────────────────

const transferInclude = {
  mo: { select: { id: true, moNumber: true, so: { select: { soNumber: true, customerPORef: true, customer: { select: { name: true } } } } } },
  fromStep: { select: { id: true, name: true, departmentId: true, department: { select: { name: true } } } },
  toStep: { select: { id: true, name: true, kind: true, isQcStep: true, departmentId: true, department: { select: { name: true } } } },
  vendor: { select: { id: true, name: true, gstin: true, address: true, city: true, state: true, stateCode: true } },
  jobWorkOrder: { select: { id: true, orderNumber: true, rate: true } },
  jobCard: {
    select: {
      id: true,
      jobCardNumber: true,
      orderNo: true,
      projectId: true,
      designNo: true,
      fabricQuality: true,
      lotNo: true,
      moLine: { select: { color: true, style: { select: { code: true } } } },
    },
  },
  createdBy: { select: { name: true } },
  cancelledBy: { select: { name: true } },
  lines: {
    orderBy: { bundle: { bundleNo: 'asc' } },
    select: {
      id: true,
      dispatchedQty: true,
      receivedQty: true,
      shortQty: true,
      settledQty: true,
      excessQty: true,
      bundle: {
        select: {
          id: true,
          code: true,
          bundleNo: true,
          size: { select: { code: true, sequence: true } },
          moLine: { select: { color: true, style: { select: { code: true, name: true } } } },
        },
      },
    },
  },
} satisfies Prisma.ProcessTransferInclude

/**
 * Transfers with the stages each passed by on its order's route — none for
 * one sent in the route's order. Only transfers made before the order was
 * kept strictly can have any; the screen offers to take those back.
 */
async function withPassed<T extends { moId: string; fromStepId: string; toStepId: string; isRework: boolean; status: string }>(rows: T[]) {
  const moIds = [...new Set(rows.map((r) => r.moId))]
  const steps = moIds.length
    ? await prisma.mOStep.findMany({ where: { moId: { in: moIds } }, select: { id: true, moId: true, sequence: true, name: true, kind: true, isQcStep: true, execution: true, skippedAt: true } })
    : []
  return rows.map((r) => ({
    ...r,
    passed: r.isRework || r.status === 'CANCELLED' ? [] : passedBy(steps.filter((s) => s.moId === r.moId), r.fromStepId, r.toStepId).map((s) => s.name),
  }))
}


const OPEN_TRANSFER: TransferStatus[] = ['DISPATCHED', 'PARTLY_RECEIVED', 'DISCREPANCY']

/** The views of the transfers list, as its tabs name them. */
const VIEWS: Record<string, Prisma.ProcessTransferWhereInput> = {
  count: { vendorId: null, status: { in: ['DISPATCHED', 'PARTLY_RECEIVED'] } },
  short: { status: 'DISCREPANCY' },
  units: { vendorId: { not: null }, status: { in: ['DISPATCHED', 'PARTLY_RECEIVED'] } },
  received: { status: 'RECEIVED' },
  cancelled: { status: 'CANCELLED' },
}

/** GET /transfers/counts — how many transfers each tab of the list holds. */
router.get('/transfers/counts', requirePermission(MODULE, 'view'), async (_req, res) => {
  const [count, short, units, received, all] = await Promise.all([
    prisma.processTransfer.count({ where: VIEWS.count }),
    prisma.processTransfer.count({ where: VIEWS.short }),
    prisma.processTransfer.count({ where: VIEWS.units }),
    prisma.processTransfer.count({ where: VIEWS.received }),
    prisma.processTransfer.count(),
  ])
  res.json({ success: true, data: { count, short, units, received, all } })
})

/** GET /transfers — filters: moId, status, open=1, vendor=1|0, q, page, limit. */
router.get('/transfers', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const and: Prisma.ProcessTransferWhereInput[] = []
  const moId = text(req.query.moId)
  if (moId) and.push({ moId })
  const jobCardId = text(req.query.jobCardId)
  if (jobCardId) and.push({ jobCardId })
  const view = text(req.query.view)
  if (view && VIEWS[view]) and.push(VIEWS[view])
  const stepId = text(req.query.toStepId)
  if (stepId) and.push({ toStepId: stepId })
  const status = text(req.query.status)
  if (status) and.push({ status: status as TransferStatus })
  if (req.query.open === '1') and.push({ status: { in: OPEN_TRANSFER } })
  if (req.query.vendor === '1') and.push({ vendorId: { not: null } })
  if (req.query.vendor === '0') and.push({ vendorId: null })
  const q = text(req.query.q)
  if (q) {
    and.push({
      OR: [
        { transferNumber: { contains: q, mode: 'insensitive' } },
        { mo: { moNumber: { contains: q, mode: 'insensitive' } } },
        { jobCard: { jobCardNumber: { contains: q, mode: 'insensitive' } } },
        { jobCard: { designNo: { contains: q, mode: 'insensitive' } } },
        { fromStep: { name: { contains: q, mode: 'insensitive' } } },
        { toStep: { name: { contains: q, mode: 'insensitive' } } },
        { vendor: { name: { contains: q, mode: 'insensitive' } } },
        { lines: { some: { bundle: { code: { contains: q, mode: 'insensitive' } } } } },
      ],
    })
  }
  const where: Prisma.ProcessTransferWhereInput = and.length ? { AND: and } : {}
  const [rows, total] = await Promise.all([
    prisma.processTransfer.findMany({ where, include: transferInclude, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.processTransfer.count({ where }),
  ])
  res.json({ success: true, data: await withPassed(rows), pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 } })
})

router.get('/transfers/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const t = await prisma.processTransfer.findUnique({ where: { id: req.params.id }, include: transferInclude })
  if (!t) throw new AppError('Transfer not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: (await withPassed([t]))[0] })
})

/**
 * GET /transfers/:id/print — the transfer card; to an outside unit, the
 * job-work challan, with the goods' HSN and a value for the challan.
 */
router.get('/transfers/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const t = await prisma.processTransfer.findUnique({ where: { id: req.params.id }, include: transferInclude })
  if (!t) throw new AppError('Transfer not found', 404, 'NOT_FOUND')
  const header = await getPrintHeader(t.vendorId ? 'JW' : 'PTC')
  // What a garment of each line is carried at for the challan: its BOM cost,
  // else the item's standard rate; and the HSN it is billed under.
  const lines = await prisma.mOLine.findMany({
    where: { moId: t.moId },
    select: { color: true, style: { select: { code: true } }, bom: { select: { costPerPiece: true, totalCost: true } }, soLine: { select: { item: { select: { name: true, hsnCode: true, standardRate: true } } } } },
  })
  const goods = lines.map((l) => ({
    style: l.style.code,
    color: l.color,
    item: l.soLine?.item.name ?? null,
    hsnCode: l.soLine?.item.hsnCode ?? null,
    rate: Number(l.bom?.totalCost ?? l.soLine?.item.standardRate ?? 0),
  }))
  res.json({ success: true, data: { ...header, transfer: t, goods } })
})

/**
 * Where pieces at a step go next: the next step of the order's route (none
 * from the last one), with how many pieces of each bundle may go there and,
 * for the last step, what each bundle still has to go through first.
 */
router.get('/orders/:id/destinations', requirePermission(MODULE, 'view'), async (req, res) => {
  const fromStepId = typeof req.query.fromStepId === 'string' ? req.query.fromStepId : ''
  if (!fromStepId) throw new AppError('Say which step the pieces are at.', 400, 'NO_STEP')
  const mo = await prisma.manufacturingOrder.findUnique({
    where: { id: req.params.id },
    select: { id: true, steps: { orderBy: { sequence: 'asc' }, select: { id: true, sequence: true, name: true, kind: true, isQcStep: true, execution: true, skippedAt: true } } },
  })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  const list = await destinationsOf(prisma, mo, fromStepId)
  res.json({
    success: true,
    data: list.map((c) => ({ stepId: c.step.id, name: c.step.name, last: c.last, next: c.next, caps: c.caps, missing: c.missing })),
  })
})

router.post('/orders/:id/transfers', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = dispatchSchema.parse(req.body)
  const out = await prisma.$transaction((tx) => dispatch(tx, req.params.id, data, req.user!.id), T)
  const t = await prisma.processTransfer.findUniqueOrThrow({ where: { id: out.transfer.id }, include: transferInclude })
  if (!out.duplicate) await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'ProcessTransfer', entityId: t.id, after: t })
  const total = t.lines.reduce((s, l) => s + l.dispatchedQty, 0)
  res.status(out.duplicate ? 200 : 201).json({
    success: true,
    message: out.duplicate
      ? `${t.transferNumber} was already saved.`
      : t.vendor
        ? `${t.transferNumber}: ${pcs(total)} pieces in ${t.lines.length} ${t.lines.length === 1 ? 'bundle' : 'bundles'} sent to ${t.vendor.name} for ${t.toStep.name}, on ${t.jobWorkOrder?.orderNumber}. Print the job-work challan to go with them.`
        : t.fromStep.departmentId === t.toStep.departmentId
          ? `${pcs(total)} pieces moved on to ${t.toStep.name}. Both are ${t.toStep.department.name}, so they are there now: nothing to count in, no card to print.`
          : `${t.transferNumber}: ${pcs(total)} pieces in ${t.lines.length} ${t.lines.length === 1 ? 'bundle' : 'bundles'} sent from ${t.fromStep.name} to ${t.toStep.name}, waiting to be counted in.`,
    data: t,
  })
})

router.post('/transfers/:id/receive', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = receiveSchema.parse(req.body)
  const out = await prisma.$transaction((tx) => receive(tx, req.params.id, data, req.user!.id), T)
  const t = await prisma.processTransfer.findUniqueOrThrow({ where: { id: req.params.id }, include: transferInclude })
  if (!out.duplicate) await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ProcessTransfer', entityId: t.id, after: t })
  const got = t.lines.reduce((s, l) => s + l.receivedQty, 0)
  const short = t.lines.reduce((s, l) => s + l.shortQty - l.settledQty, 0)
  const excess = t.lines.reduce((s, l) => s + l.excessQty, 0)
  res.json({
    success: true,
    message: out.duplicate
      ? 'That count was already saved.'
      : `${t.transferNumber}: ${pcs(got)} counted in at ${t.toStep.name}.${excess ? ` ${pcs(excess)} more than was sent — taken off ${t.fromStep.name}.` : ''}${short ? ` ${pcs(short)} short, to be settled.` : t.status === 'PARTLY_RECEIVED' ? ' The rest is still on its way.' : ''}`,
    data: t,
  })
})

router.post('/transfers/:id/settle', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = settleSchema.parse(req.body)
  await prisma.$transaction((tx) => settleShort(tx, req.params.id, data, { userId: req.user!.id, mayApprove: mayApprove(req) }), T)
  const t = await prisma.processTransfer.findUniqueOrThrow({ where: { id: req.params.id }, include: transferInclude })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ProcessTransfer', entityId: t.id, after: t })
  const open = t.lines.reduce((s, l) => s + l.shortQty - l.settledQty, 0)
  res.json({ success: true, message: open ? `${t.transferNumber}: ${pcs(open)} still short.` : `${t.transferNumber} is settled.`, data: t })
})

router.post('/transfers/:id/cancel', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const t = await prisma.$transaction((tx) => cancelTransfer(tx, req.params.id, reason, req.user!.id), T)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ProcessTransfer', entityId: t.id, after: t })
  res.json({ success: true, message: `${t.transferNumber} taken back: the pieces are back where they were sent from.`, data: t })
})

// ─── Work at a step ───────────────────────────────────────────

router.post('/orders/:id/steps/:stepId/work', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = workSchema.parse(req.body)
  const out = await prisma.$transaction((tx) => recordWork(tx, req.params.id, req.params.stepId, data, req.user!.id), T)
  if (out.duplicate) return res.json({ success: true, message: 'That was already saved.' })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'WipEvent', entityId: out.event!.id, after: data })
  const t = (k: 'done' | 'damaged' | 'rejected' | 'rework' | 'bGrade') => data.lines.reduce((s, l) => s + (l[k] ?? 0), 0)
  const parts = [
    t('done') && `${pcs(t('done'))} done`,
    t('rework') && `${pcs(t('rework'))} to rework`,
    t('rejected') && `${pcs(t('rejected'))} rejected`,
    t('damaged') && `${pcs(t('damaged'))} damaged`,
    t('bGrade') && `${pcs(t('bGrade'))} B-grade`,
  ].filter(Boolean)
  res.status(201).json({ success: true, message: `Recorded: ${parts.join(', ')}.` })
})

router.post('/orders/:id/steps/:stepId/decide', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = decideSchema.parse(req.body)
  const out = await prisma.$transaction((tx) => decide(tx, req.params.id, req.params.stepId, data, { userId: req.user!.id, mayApprove: mayApprove(req) }), T)
  if (out.duplicate) return res.json({ success: true, message: 'That was already saved.' })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'WipEvent', entityId: out.event!.id, after: data })
  const n = data.lines.reduce((s, l) => s + l.qty, 0)
  const to = { REWORK: 'sent for rework', B_GRADE: 'set aside as B-grade', SCRAPPED: 'written off', DONE: 'passed as they are', WIP: 'back to be checked again', DAMAGED: 'marked damaged', REJECTED: 'marked rejected' }[data.to]
  res.status(201).json({ success: true, message: `${pcs(n)} ${n === 1 ? 'piece' : 'pieces'} ${to}.` })
})

router.post('/orders/:id/steps/:stepId/rework-done', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = reworkDoneSchema.parse(req.body)
  const out = await prisma.$transaction((tx) => reworkDone(tx, req.params.id, req.params.stepId, data, req.user!.id), T)
  if (out.duplicate) return res.json({ success: true, message: 'That was already saved.' })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'WipEvent', entityId: out.event!.id, after: data })
  const n = data.lines.reduce((s, l) => s + l.qty, 0)
  res.status(201).json({ success: true, message: `${pcs(n)} ${n === 1 ? 'piece' : 'pieces'} put right.` })
})

router.post('/events/:id/undo', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const out = await prisma.$transaction((tx) => undoEvent(tx, req.params.id, reason, req.user!.id), T)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'WipEvent', entityId: req.params.id, after: { undoneBy: out.reversal.id, reason } })
  res.json({ success: true, message: 'Undone: the pieces are back where they were.' })
})

// ─── Job work orders ──────────────────────────────────────────

const jwoInclude = {
  mo: { select: { id: true, moNumber: true, so: { select: { soNumber: true, customer: { select: { name: true } } } } } },
  step: { select: { id: true, name: true } },
  vendor: { select: { id: true, name: true } },
  wipEvents: {
    where: { type: { in: ['DISPATCH', 'VENDOR_RETURN'] }, reversedAt: null },
    select: { type: true, chargeQty: true, chargeRate: true, billNo: true, entries: { select: { bucket: true, qty: true, vendorId: true } } },
  },
} satisfies Prisma.JobWorkOrderInclude

/** GET /job-work-orders — filters: status, vendorId, moId, q. With what each unit holds and what is charged. */
router.get('/job-work-orders', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const and: Prisma.JobWorkOrderWhereInput[] = []
  const status = text(req.query.status)
  if (status) and.push({ status: status as Prisma.EnumJobWorkOrderStatusFilter['equals'] })
  const vendorId = text(req.query.vendorId)
  if (vendorId) and.push({ vendorId })
  const moId = text(req.query.moId)
  if (moId) and.push({ moId })
  const q = text(req.query.q)
  if (q) {
    and.push({
      OR: [
        { orderNumber: { contains: q, mode: 'insensitive' } },
        { mo: { moNumber: { contains: q, mode: 'insensitive' } } },
        { vendor: { name: { contains: q, mode: 'insensitive' } } },
        { step: { name: { contains: q, mode: 'insensitive' } } },
      ],
    })
  }
  const where: Prisma.JobWorkOrderWhereInput = and.length ? { AND: and } : {}
  const [rows, total] = await Promise.all([
    prisma.jobWorkOrder.findMany({ where, include: jwoInclude, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.jobWorkOrder.count({ where }),
  ])
  // What each unit holds now, read off the ledger for these orders' steps.
  const held = rows.length
    ? await prisma.wipEntry.groupBy({
        by: ['stepId', 'vendorId'],
        where: { stepId: { in: rows.map((r) => r.stepId) }, vendorId: { in: rows.map((r) => r.vendorId) } },
        _sum: { qty: true },
      })
    : []
  res.json({
    success: true,
    data: rows.map((j) => {
      const entries = j.wipEvents.flatMap((e) => e.entries.map((x) => ({ ...x, type: e.type })))
      const returns = j.wipEvents.filter((e) => e.type === 'VENDOR_RETURN')
      const charged = returns.reduce((s, e) => s + (e.chargeQty ?? 0) * Number(e.chargeRate ?? 0), 0)
      return {
        id: j.id,
        orderNumber: j.orderNumber,
        status: j.status,
        rate: Number(j.rate),
        expectedBy: j.expectedBy,
        createdAt: j.createdAt,
        mo: j.mo,
        step: j.step,
        vendor: j.vendor,
        sent: entries.filter((x) => x.type === 'DISPATCH' && x.bucket === 'WIP' && x.vendorId && x.qty > 0).reduce((s, x) => s + x.qty, 0),
        accepted: entries.filter((x) => x.type === 'VENDOR_RETURN' && x.bucket === 'DONE' && x.qty > 0).reduce((s, x) => s + x.qty, 0),
        rejected: entries.filter((x) => x.type === 'VENDOR_RETURN' && x.bucket === 'REJECTED' && x.qty > 0).reduce((s, x) => s + x.qty, 0),
        damaged: entries.filter((x) => x.type === 'VENDOR_RETURN' && x.bucket === 'DAMAGED' && x.qty > 0).reduce((s, x) => s + x.qty, 0),
        held: held.find((h) => h.stepId === j.stepId && h.vendorId === j.vendorId)?._sum.qty ?? 0,
        charged: Math.round(charged * 100) / 100,
        unbilled: Math.round(returns.filter((e) => !e.billNo).reduce((s, e) => s + (e.chargeQty ?? 0) * Number(e.chargeRate ?? 0), 0) * 100) / 100,
      }
    }),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.post('/job-work-orders/:id/return', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = vendorReturnSchema.parse(req.body)
  const out = await prisma.$transaction((tx) => vendorReturn(tx, req.params.id, data, req.user!.id), T)
  if (out.duplicate) return res.json({ success: true, message: 'That return was already saved.' })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'WipEvent', entityId: out.event!.id, after: data })
  const t = (k: 'accepted' | 'rejected' | 'damaged') => data.lines.reduce((s, l) => s + (l[k] ?? 0), 0)
  const ev = out.event!
  res.status(201).json({
    success: true,
    message: `Back from the unit: ${pcs(t('accepted'))} accepted${t('rejected') ? `, ${pcs(t('rejected'))} rejected` : ''}${t('damaged') ? `, ${pcs(t('damaged'))} damaged (chargeable to them)` : ''}. Charged: ${pcs(ev.chargeQty ?? 0)} × ₹${Number(ev.chargeRate ?? 0)}.`,
  })
})

router.post('/job-work-orders/:id/send-back', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = sendBackSchema.parse(req.body)
  const out = await prisma.$transaction((tx) => sendBack(tx, req.params.id, data, req.user!.id), T)
  if (!out.duplicate) await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'ProcessTransfer', entityId: out.transfer.id, after: out.transfer })
  const n = data.lines.reduce((s, l) => s + l.qty, 0)
  res.status(201).json({ success: true, message: `${out.transfer.transferNumber}: ${pcs(n)} pieces sent back to put right. Print the challan to go with them.`, data: out.transfer })
})

router.post('/job-work-orders/:id/close', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const j = await prisma.$transaction((tx) => closeJobWorkOrder(tx, req.params.id), T)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'JobWorkOrder', entityId: j.id, after: j })
  res.json({ success: true, message: `${j.orderNumber} closed.` })
})

router.patch('/job-work-returns/:eventId/bill', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = billSchema.parse(req.body)
  const ev = await prisma.$transaction((tx) => setReturnBill(tx, req.params.eventId, data), T)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'WipEvent', entityId: ev.id, after: data })
  res.json({ success: true, message: `Bill ${data.billNo} noted against the return.` })
})

// ─── Job cards and the departments' sheets ────────────────────

const page = (req: AuthRequest | Parameters<Parameters<typeof router.get>[1]>[0]) => ({
  page: Math.max(1, Number(req.query.page) || 1),
  limit: Math.min(200, Math.max(1, Number(req.query.limit) || 25)),
})

/** GET /job-cards?q=&show=open|all&moId= — one per colour of each order, with where its pieces are. */
router.get('/job-cards', requirePermission(MODULE, 'view'), async (req, res) => {
  const p = page(req)
  const out = await listJobCards(prisma, { q: text(req.query.q), show: text(req.query.show), moId: text(req.query.moId), ...p })
  res.json({ success: true, data: out.data, pagination: { ...p, total: out.total, pages: Math.ceil(out.total / p.limit) || 1 } })
})

/** GET /job-cards/:id — the job card and everything its sheets show. */
router.get('/job-cards/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  // Anything the order has learnt since the card was made fills its blanks.
  const card = await prisma.jobCard.findUnique({ where: { id: req.params.id }, select: { moId: true } })
  if (card) await prisma.$transaction((tx) => fillJobCardBlanks(tx, card.moId), { timeout: 30_000 })
  res.json({ success: true, data: await jobCardDetail(prisma, req.params.id) })
})

/** GET /job-cards/:id/print?stepId= — the job card, or one of its sheets, to print. */
router.get('/job-cards/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const detail = await jobCardDetail(prisma, req.params.id)
  const step = detail.steps.find((s) => s.id === text(req.query.stepId))
  const header = await getPrintHeader(!step ? 'JC' : step.kind === 'CUTTING' ? 'CUT' : 'SHEET')
  // The department's challan run on this order, e.g. CUT/2627-0002: its challans are /01, /02 under it.
  const op = step ? await prisma.operation.findUnique({ where: { id: step.operationId }, select: { code: true } }) : null
  const series = step ? `${processCode(op?.code, processCode(step.name, 'GEN'))}/${detail.mo.moNumber.replace(/^MO-/, '')}` : null
  res.json({ success: true, data: { ...header, detail, series } })
})

router.patch('/job-cards/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = jobCardSchema.parse(req.body)
  const card = await prisma.$transaction((tx) => updateJobCard(tx, req.params.id, data), T)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'JobCard', entityId: card.id, after: card })
  res.json({ success: true, message: `${card.jobCardNumber} saved.`, data: card })
})

/** GET /stage-tabs — the stages on open orders' routes, with the work waiting at each. */
/**
 * GET /stage-report?operationId=&from=&to=&moId= — everything that happened at
 * one stage, entry by entry: in, done, sent on, damaged and why.
 */
router.get('/stage-report', requirePermission(MODULE, 'view'), async (req, res) => {
  const s = (k: string) => (typeof req.query[k] === 'string' && req.query[k] ? (req.query[k] as string) : undefined)
  const operationId = s('operationId')
  if (!operationId) throw new AppError('Say which stage.', 400, 'NO_STAGE')
  const from = s('from') ? new Date(`${s('from')}T00:00:00+05:30`) : undefined
  const to = s('to') ? new Date(`${s('to')}T23:59:59.999+05:30`) : undefined
  res.json({ success: true, data: await stageReport(prisma, { operationId, from, to, moId: s('moId') }) })
})

/** GET /board?q=&show=open|all — every open job card, its route, and where its pieces are stage by stage. */
router.get('/board', requirePermission(MODULE, 'view'), async (req, res) => {
  const p = page(req)
  const out = await boardCards(prisma, { q: text(req.query.q), show: text(req.query.show), ...p })
  res.json({ success: true, data: out.data, pagination: { ...p, total: out.total, pages: Math.ceil(out.total / p.limit) || 1 } })
})

router.get('/stage-tabs', requirePermission(MODULE, 'view'), async (_req, res) => {
  res.json({ success: true, data: await stageTabs(prisma) })
})

/** GET /stage-sheets?operationId=|stage=&show=active|waiting|done|all — one stage's sheets. */
router.get('/stage-sheets', requirePermission(MODULE, 'view'), async (req, res) => {
  const stage = text(req.query.stage) as Stage | undefined
  const operationId = text(req.query.operationId)
  if (stage && !STAGES.includes(stage)) throw new AppError('That is not a stage', 400, 'NO_STAGE')
  if (!stage && !operationId) throw new AppError('Say which stage', 400, 'NO_STAGE')
  const p = page(req)
  const out = await stageSheets(prisma, { stage, q: text(req.query.q), show: text(req.query.show), operationId, ...p })
  res.json({ success: true, data: out.data, pagination: { ...p, total: out.total, pages: Math.ceil(out.total / p.limit) || 1 } })
})

/** GET /cutting-contractors — every cutting contractor named before, latest first, for the pick list. */
router.get('/cutting-contractors', requirePermission(MODULE, 'view'), async (_req, res) => {
  res.json({ success: true, data: await cuttingContractors(prisma) })
})

/** POST /orders/:id/cutting-issues — sizes issued to a cutting contractor, on the cutting sheet. */
router.post('/orders/:id/cutting-issues', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = cutterIssueSchema.parse(req.body)
  const issue = await prisma.$transaction((tx) => issueToCutter(tx, req.params.id, data, req.user!.id, { mayApprove: mayApprove(req) }), T)
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'CuttingOrder', entityId: issue.id, after: issue })
  res.status(201).json({ success: true, message: `${issue.cutOrderNumber}: ${pcs(issue.plannedPieces)} pieces issued to ${issue.cutterName} for cutting.`, data: issue })
})

/** POST /cutting/:id/receive — what came back cut from the contractor: tied into bundles, stickers to print. */
router.post('/cutting/:id/receive', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const issue = await prisma.cuttingOrder.findUnique({ where: { id: req.params.id }, select: { moId: true, fabricItemId: true } })
  if (!issue) throw new AppError('That issue to a cutting contractor was not found', 404, 'NOT_FOUND')
  const data = cuttingSchema.parse({ ...req.body, fabricItemId: req.body?.fabricItemId || issue.fabricItemId || '' })
  const cut = await prisma.$transaction((tx) => createCutting(tx, issue.moId, data, req.user!.id, { mayApprove: mayApprove(req), issueId: req.params.id }), T)
  const bundles = await prisma.productionBundle.count({ where: { cuttingOrderId: cut.id } })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'CuttingOrder', entityId: cut.id, after: cut })
  res.json({
    success: true,
    message: `${cut.cutOrderNumber}: ${pcs(cut.actualPieces)} pieces received from ${cut.cutterName ?? 'the contractor'}, tied into ${bundles} ${bundles === 1 ? 'bundle' : 'bundles'}. Print the stickers.`,
    data: { ...cut, bundles },
  })
})

// ─── Prints: bundle stickers and the cutting document ─────────

/** GET /orders/:id/stickers?cutting=&ids=a,b — what each bundle's sticker says. */
router.get('/orders/:id/stickers', requirePermission(MODULE, 'view'), async (req, res) => {
  const cuttingId = text(req.query.cutting)
  const moLineId = text(req.query.line)
  const ids = String(req.query.ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const mo = await prisma.manufacturingOrder.findUnique({
    where: { id: req.params.id },
    select: { moNumber: true, so: { select: { soNumber: true, customerPORef: true, customer: { select: { name: true } } } } },
  })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  const bundles = await prisma.productionBundle.findMany({
    where: { moId: req.params.id, ...(cuttingId ? { cuttingOrderId: cuttingId } : {}), ...(moLineId ? { moLineId } : {}), ...(ids.length ? { id: { in: ids } } : {}) },
    orderBy: { bundleNo: 'asc' },
    select: {
      id: true,
      code: true,
      bundleNo: true,
      qty: true,
      size: { select: { code: true } },
      moLine: { select: { color: true, style: { select: { code: true, name: true } } } },
      cuttingOrder: { select: { cutOrderNumber: true, cutDate: true, lotNo: true, status: true } },
    },
  })
  const company = await prisma.company.findFirst({ select: { name: true } })
  res.json({
    success: true,
    data: {
      company: company?.name ?? '',
      mo,
      bundles: bundles.filter((b) => b.cuttingOrder.status !== 'CANCELLED'),
    },
  })
})

/** GET /cutting/:id/print — the cutting document: the lay, sizes planned and cut, and the bundles. */
router.get('/cutting/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const cut = await prisma.cuttingOrder.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      cutOrderNumber: true,
      cutDate: true,
      status: true,
      fabricIssued: true,
      fabricUsed: true,
      wastage: true,
      noOfLayers: true,
      lotNo: true,
      ratio: true,
      cutterName: true,
      bundleSize: true,
      sizeBreakup: true,
      plannedBreakup: true,
      actualPieces: true,
      notes: true,
      createdAt: true,
      createdBy: { select: { name: true } },
      fabricItem: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
      moLine: { select: { color: true, totalQty: true, style: { select: { code: true, name: true } }, sizes: { select: { sizeId: true, qty: true, size: { select: { code: true, sequence: true } } } } } },
      mo: {
        select: {
          id: true,
          moNumber: true,
          totalPlannedQty: true,
          so: { select: { soNumber: true, customerPORef: true, customer: { select: { name: true } } } },
        },
      },
      bundles: { orderBy: { bundleNo: 'asc' }, select: { id: true, code: true, bundleNo: true, qty: true, size: { select: { code: true } } } },
    },
  })
  if (!cut) throw new AppError('Cutting not found', 404, 'NOT_FOUND')
  // Where its bundles are now: what has gone on to the next step.
  const held = await balancesOf(prisma, cut.mo.id)
  const ids = new Set(cut.bundles.map((b) => b.id))
  const atCutting = held.filter((r) => ids.has(r.bundleId) && r.bucket === 'DONE')
  const steps = await prisma.mOStep.findMany({ where: { moId: cut.mo.id, kind: 'CUTTING' }, select: { id: true } })
  const cuttingStepIds = new Set(steps.map((s) => s.id))
  const waiting = atCutting.filter((r) => cuttingStepIds.has(r.stepId)).reduce((s, r) => s + r.qty, 0)
  res.json({ success: true, data: { ...(await getPrintHeader('CUT')), cutting: cut, waitingAtCutting: waiting } })
})

export default router
