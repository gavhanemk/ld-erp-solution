import { Router, type Response } from 'express'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { requirePermission, userCan, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { leaveOutStep, listStyles, noteStep, startStep, stopStep, styleDetail, undoStep } from '../services/styleTrack.service'

/**
 * Masters → Routings, by style: every style with its routing and where it
 * stands, and one style's page with a Start and a Stop for each step.
 * Mounted at /api/masters/style-tracking, ahead of the masters router.
 *
 * Reading is masters:view, like the rest of Masters. Pressing Start, Stop or
 * leaving a step out is recording production, so it needs production:create —
 * the floor desks have it; leaving out a required step also needs
 * production:approve. Undoing needs production:edit, with a reason.
 */

const router = Router()
const T = { timeout: 30_000, maxWait: 10_000 }

const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(500) })
const noteSchema = z.object({ note: z.string().trim().max(300).nullable().optional() })
const stepParams = z.object({ styleId: z.string().min(1), operationId: z.string().min(1), occurrence: z.coerce.number().int().min(1) })

const who = (req: AuthRequest) => ({ userId: req.user!.id, mayApprove: userCan(req.user, 'production', 'approve') })

router.get('/', requirePermission('masters', 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const result = await listStyles(prisma, {
    q: typeof req.query.q === 'string' ? req.query.q : undefined,
    state: typeof req.query.state === 'string' ? req.query.state : undefined,
    includeInactive: req.query.inactive === 'true',
    page,
    limit,
  })
  res.json({
    success: true,
    data: result.rows,
    counts: result.counts,
    pagination: { page, limit, total: result.total, pages: Math.ceil(result.total / limit) || 1 },
  })
})

router.get('/:styleId', requirePermission('masters', 'view'), async (req, res) => {
  res.json({ success: true, data: await styleDetail(prisma, req.params.styleId) })
})

/** Writes one step action in a transaction, audits it, and answers with the page's fresh data. */
async function act(
  req: AuthRequest,
  res: Response,
  run: (tx: Prisma.TransactionClient, p: z.infer<typeof stepParams>) => Promise<{ before: unknown; run: { id: string } | null; message: string }>,
) {
  const p = stepParams.parse(req.params)
  const done = await prisma.$transaction((tx) => run(tx, p), T)
  await writeAuditLog(req, {
    module: 'production',
    action: 'UPDATE',
    entityType: 'StyleStepRun',
    entityId: done.run?.id ?? `${p.styleId}:${p.operationId}:${p.occurrence}`,
    before: done.before,
    after: done.run ?? { removed: true, ...(req.body?.reason ? { reason: req.body.reason } : {}) },
  })
  res.json({ success: true, message: done.message, data: await styleDetail(prisma, p.styleId) })
}

router.post('/:styleId/steps/:operationId/:occurrence/start', requirePermission('production', 'create'), (req: AuthRequest, res) =>
  act(req, res, (tx, p) => startStep(tx, p.styleId, p.operationId, p.occurrence, who(req))),
)

router.post('/:styleId/steps/:operationId/:occurrence/stop', requirePermission('production', 'create'), (req: AuthRequest, res) =>
  act(req, res, (tx, p) => stopStep(tx, p.styleId, p.operationId, p.occurrence, who(req))),
)

router.post('/:styleId/steps/:operationId/:occurrence/leave-out', requirePermission('production', 'create'), (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  return act(req, res, (tx, p) => leaveOutStep(tx, p.styleId, p.operationId, p.occurrence, reason, who(req)))
})

router.post('/:styleId/steps/:operationId/:occurrence/undo', requirePermission('production', 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const p = stepParams.parse(req.params)
  const done = await prisma.$transaction((tx) => undoStep(tx, p.styleId, p.operationId, p.occurrence, who(req)), T)
  // The reason goes on the audit record: the undo leaves no other trace.
  await writeAuditLog(req, {
    module: 'production',
    action: 'UPDATE',
    entityType: 'StyleStepRun',
    entityId: done.run?.id ?? done.before?.id ?? `${p.styleId}:${p.operationId}:${p.occurrence}`,
    before: done.before,
    after: { ...(done.run ?? { removed: true }), undoReason: reason },
  })
  res.json({ success: true, message: done.message, data: await styleDetail(prisma, p.styleId) })
})

router.patch('/:styleId/steps/:operationId/:occurrence/note', requirePermission('production', 'create'), (req: AuthRequest, res) => {
  const { note } = noteSchema.parse(req.body)
  return act(req, res, (tx, p) => noteStep(tx, p.styleId, p.operationId, p.occurrence, note?.trim() || null))
})

export default router
