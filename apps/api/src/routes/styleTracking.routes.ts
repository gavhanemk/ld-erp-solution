import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { listStyles, noteStep, styleDetail } from '../services/styleTrack.service'

/**
 * Masters → Routings, by style: every style with its routing and where it
 * stands on the floor, and one style's page with each step of its routing.
 * Mounted at /api/masters/style-tracking, ahead of the masters router.
 *
 * Reading is masters:view, like the rest of Masters. Where a step stands comes
 * from the floor's own records, so nothing here records production; the only
 * write is a note on a step, which needs production:create — the floor desks
 * have it. (The Start, Stop, leave-out and undo there were until 15 Oct 2026
 * are gone.)
 */

const router = Router()
const T = { timeout: 30_000, maxWait: 10_000 }

const noteSchema = z.object({ note: z.string().trim().max(300).nullable().optional() })
const stepParams = z.object({ styleId: z.string().min(1), operationId: z.string().min(1), occurrence: z.coerce.number().int().min(1) })

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

router.patch('/:styleId/steps/:operationId/:occurrence/note', requirePermission('production', 'create'), async (req: AuthRequest, res) => {
  const p = stepParams.parse(req.params)
  const { note } = noteSchema.parse(req.body)
  const done = await prisma.$transaction((tx) => noteStep(tx, p.styleId, p.operationId, p.occurrence, note?.trim() || null), T)
  await writeAuditLog(req, {
    module: 'production',
    action: 'UPDATE',
    entityType: 'StyleStepRun',
    entityId: done.run?.id ?? done.before?.id ?? `${p.styleId}:${p.operationId}:${p.occurrence}`,
    before: done.before,
    after: done.run ?? { removed: true },
  })
  res.json({ success: true, message: done.message, data: await styleDetail(prisma, p.styleId) })
})

export default router
