import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { z } from 'zod'
import { requirePermission, userCan, type AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { samplingPilotEnabled } from '../lib/pilot'
import { removeObject, signedDownloadUrl, signedUploadUrl, storagePathFor } from '../lib/storage'
import { nextStyleCode } from '../lib/masterCode'
import { createItemRecord } from '../lib/itemMaster'
import { SAMPLE_ATTACHMENT_KIND_LABEL, SAMPLE_MATERIAL_TYPES } from '@ld-erp/shared'
import {
  createSampleSchema,
  sampleActionSchema,
  sampleAttachmentListSchema,
  sampleItemSearchSchema,
  sampleUploadUrlSchema,
} from '../schemas/sampling.schemas'
import {
  SAMPLE_FILE_FOLDER,
  actOnSample,
  attachmentLock,
  createSample,
  fileLimitProblem,
  routeTemplate,
  routingAsRoute,
  sampleDetail,
  sampleItemOption,
  sampleLookups,
  searchSampleItems,
  type SampleAfterCommit,
} from '../services/sampling.service'
import { routingsFor } from '../services/route.service'

const router = Router()
/**
 * The pilot must never point at the shared database, even with the flag set.
 * The rule itself lives in lib/pilot.ts, so local file storage asks exactly
 * the same question and cannot drift from it.
 */
export function samplingEnabled() {
  return samplingPilotEnabled()
}
router.use((_req, res, next) =>
  samplingEnabled()
    ? next()
    : res.status(404).json({
        success: false,
        message: 'Sampling is available in the isolated local pilot only.',
      })
)
router.use(requirePermission('sampling', 'view'))
const T = { timeout: 60000, maxWait: 15000 }
function visible(row: Awaited<ReturnType<typeof sampleDetail>>, req: AuthRequest) {
  // Each file says whether it can still be removed, by the rule DETACH applies,
  // so the screen never offers a removal the server will refuse.
  const attachments = row.attachments.map((f) => {
    const lockedReason = attachmentLock(row, f)
    return { ...f, removable: !lockedReason, lockedReason }
  })
  if (userCan(req.user, 'accounts', 'view')) return { ...row, attachments }
  return {
    ...row,
    attachments,
    rounds: row.rounds.map((r) => ({
      ...r,
      materials: r.materials.map(({ issuedValue, returnedValue, ...m }) => m),
    })),
  }
}
router.get('/lookups', async (_req, res) =>
  res.json({ success: true, data: await prisma.$transaction(sampleLookups, T) })
)
/** The usual making route from the Operation master, for a round's route to start from. */
router.get('/route-template', async (_req, res) =>
  res.json({ success: true, data: await routeTemplate(prisma) })
)

// ── Materials for the sample BOM ─────────────────────────────────────────────
//
// The BOM's picker searches the materials in use; one the buyer's tech pack
// names that we have never bought is added here, by the item master's own
// rules (lib/itemMaster), without masters rights.

router.get('/items/search', async (req, res) => {
  const q = sampleItemSearchSchema.parse(req.query)
  res.json({ success: true, data: await searchSampleItems(prisma, q.q, q.limit) })
})
router.post('/items', requirePermission('sampling', 'edit'), async (req: AuthRequest, res) => {
  // A material added from a sample is always coded from its category and in
  // use: typing a code of one's own, or adding one switched off, is for
  // somebody with masters rights.
  const body = { ...((req.body ?? {}) as Record<string, unknown>) }
  delete body.code
  delete body.isActive
  const created = await createItemRecord(body, { types: SAMPLE_MATERIAL_TYPES })
  // An item is a masters record wherever it is made, audited as Masters → Items audits one.
  await writeAuditLog(req, {
    module: 'masters',
    action: 'CREATE',
    entityType: 'Item',
    entityId: created.id,
    after: created,
  })
  res.status(201).json({ success: true, data: sampleItemOption(created) })
})
router.get('/', async (req: AuthRequest, res) => {
  const q = z
    .object({
      view: z.enum(['Requests', 'Sampling floor', 'Reviews', 'Handover']).default('Requests'),
      q: z.string().max(150).default(''),
      page: z.coerce.number().int().min(1).default(1),
      export: z.enum(['true']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    })
    .parse(req.query)
  const search = q.q
    ? {
        OR: [
          { number: { contains: q.q, mode: 'insensitive' as const } },
          { title: { contains: q.q, mode: 'insensitive' as const } },
          { buyerRef: { contains: q.q, mode: 'insensitive' as const } },
          // The buyer asks by their own style number; the floor by ours.
          { buyerStyleRef: { contains: q.q, mode: 'insensitive' as const } },
          { style: { code: { contains: q.q, mode: 'insensitive' as const } } },
          { style: { name: { contains: q.q, mode: 'insensitive' as const } } },
        ],
      }
    : {}
  if (q.export) {
    if (!userCan(req.user, 'sampling', 'export'))
      return res
        .status(403)
        .json({ success: false, message: 'Sampling export permission is required.' })
    await writeAuditLog(req, {
      module: 'sampling',
      action: 'EXPORT',
      entityType: 'SampleRegister',
      entityId: 'register',
      after: { query: q.q, view: q.view },
    })
  }
  const states: Record<string, string[]> = {
    'Sampling floor': ['RELEASED'],
    Reviews: ['QC_PASSED', 'SUBMITTED'],
    Handover: ['APPROVED'],
  }
  const where = { ...search, ...(states[q.view] ? { state: { in: states[q.view] } } : {}) }
  const [data, total] = await prisma.$transaction([
    prisma.sampleRequest.findMany({
      where,
      take: q.limit,
      skip: (q.page - 1) * q.limit,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { name: true } },
        brand: { select: { name: true } },
        style: { select: { code: true, name: true, stage: true } },
        rounds: {
          orderBy: { revision: 'desc' },
          take: 1,
          select: { id: true, revision: true, state: true, handover: true },
        },
      },
    }),
    prisma.sampleRequest.count({ where }),
  ])
  res.json({
    success: true,
    data,
    pagination: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) },
  })
})
router.post('/', requirePermission('sampling', 'create'), async (req: AuthRequest, res) => {
  const data = createSampleSchema.parse(req.body)
  let row
  try {
    row = await prisma.$transaction((tx) => createSample(tx, data, req.user!), T)
  } catch (e) {
    // Two copies of one create can arrive before either transaction sees it.
    if ((e as { code?: string }).code !== 'P2002') throw e
    const existing = await prisma.sampleRequest.findUnique({ where: { clientKey: data.clientKey } })
    if (!existing) throw e
    row = await prisma.$transaction((tx) => sampleDetail(tx, existing.id), T)
  }
  await writeAuditLog(req, {
    module: 'sampling',
    action: 'CREATE',
    entityType: 'SampleRequest',
    entityId: row.id,
    after: { number: row.number },
  })
  res.status(201).json({ success: true, data: visible(row, req) })
})
router.get('/:id/print', async (req: AuthRequest, res) => {
  const data = await prisma.$transaction(async (tx) => {
    const [request, company, lookups] = await Promise.all([
      sampleDetail(tx, req.params.id),
      tx.company.findFirst({
        select: {
          name: true,
          address: true,
          city: true,
          state: true,
          pincode: true,
          phone: true,
          email: true,
          logoUrl: true,
        },
      }),
      sampleLookups(tx),
    ])
    // Names and kinds only: a printed sheet cannot open a file, and storage
    // paths are not for paper.
    const attachments = request.attachments.map((f) => ({
      id: f.id,
      roundId: f.roundId,
      kind: f.kind,
      kindLabel:
        SAMPLE_ATTACHMENT_KIND_LABEL[f.kind as keyof typeof SAMPLE_ATTACHMENT_KIND_LABEL] ?? f.kind,
      fileName: f.fileName,
      createdAt: f.createdAt,
    }))
    return { request: { ...visible(request, req), attachments }, company, lookups }
  }, T)
  res.json({ success: true, data })
})

// ── Files kept against a request ─────────────────────────────────────────────
//
// The buyer's tech pack, patterns, photos, approvals. The same three steps as
// an order's files: ask for a link, send the file straight to storage, then
// file it. Filing and removing are the request's own actions (ATTACH and
// DETACH on /:id/actions), so they take its lock, check its version and leave
// an event in its history like every other change to a sample.

/** A link that works for a few minutes. The bucket itself stays private. */
router.get('/attachments/:attachmentId/link', async (req, res) => {
  const file = await prisma.sampleAttachment.findUnique({
    where: { id: req.params.attachmentId },
  })
  if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')
  res.json({
    success: true,
    data: { url: await signedDownloadUrl(file.storagePath), fileName: file.fileName },
  })
})

const lockFacts = {
  cancelledAt: true,
  rounds: {
    select: { id: true, revision: true, state: true, releasedAt: true, handover: true },
  },
} as const

router.get('/:id/attachments', async (req, res) => {
  const q = sampleAttachmentListSchema.parse(req.query)
  const request = await prisma.sampleRequest.findUnique({
    where: { id: req.params.id },
    select: lockFacts,
  })
  if (!request) throw new AppError('Sample request not found', 404, 'NOT_FOUND')
  const rows = await prisma.sampleAttachment.findMany({
    where: {
      requestId: req.params.id,
      ...(q.roundId ? { roundId: q.roundId === 'none' ? null : q.roundId } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
    },
    include: { uploadedBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  })
  // Whether each can still be removed, by the rule DETACH applies.
  res.json({
    success: true,
    data: rows.map((f) => {
      const lockedReason = attachmentLock(request, f)
      return { ...f, removable: !lockedReason, lockedReason }
    }),
  })
})

/** Step one: a one-use link to send the file to. Nothing is recorded yet. */
router.post(
  '/:id/attachments/upload-url',
  requirePermission('sampling', 'edit'),
  async (req, res) => {
    const d = sampleUploadUrlSchema.parse(req.body)
    const request = await prisma.sampleRequest.findUnique({
      where: { id: req.params.id },
      select: { id: true, number: true, ...lockFacts },
    })
    if (!request) throw new AppError('Sample request not found', 404, 'NOT_FOUND')
    if (request.cancelledAt) throw new AppError('This request is cancelled.', 409, 'SAMPLE_RULE')
    if (request.rounds.some((x) => x.handover))
      throw new AppError(
        'This request has a production handover. Its details are now frozen.',
        409,
        'SAMPLE_RULE'
      )
    if (d.roundId && !request.rounds.some((x) => x.id === d.roundId))
      throw new AppError('That round is not on this request.', 409, 'SAMPLE_RULE')
    // Refused early so nobody sends a file only to be turned away; ATTACH
    // counts again under the request's lock, which is the check that holds.
    if (d.kind) {
      const roundId = d.roundId || null
      const here = await prisma.sampleAttachment.findMany({
        where: { requestId: request.id, kind: d.kind, roundId },
        select: { roundId: true, kind: true, createdAt: true },
      })
      const full = fileLimitProblem(request, here, d.kind, roundId)
      if (full) throw new AppError(full, 409, 'TOO_MANY_FILES')
    }
    const path = storagePathFor(SAMPLE_FILE_FOLDER, request.id, d.fileName)
    const { uploadUrl } = await signedUploadUrl(path)
    res.json({ success: true, data: { uploadUrl, storagePath: path, fileName: d.fileName } })
  }
)
/**
 * The code a style made for this request would get, shown while it is being
 * made: the brand, garment and season decide it and it never changes, so the
 * merchandiser sees it before saving. Their own right, not the masters one.
 */
router.get(
  '/:id/next-style-code',
  requirePermission('sampling', 'edit'),
  async (req, res) => {
    const q = z
      .object({
        category: z.string().trim().max(100).default(''),
        season: z.string().trim().max(50).default(''),
      })
      .parse(req.query)
    const request = await prisma.sampleRequest.findUnique({
      where: { id: req.params.id },
      select: { brandId: true },
    })
    if (!request) throw new AppError('Sample request not found', 404, 'NOT_FOUND')
    res.json({
      success: true,
      data: { code: await nextStyleCode({ brandId: request.brandId, ...q }) },
    })
  }
)
/**
 * The production routings the request's style could take, best fit first
 * (routingsFor, as an order is offered them), for a round's route to start
 * from. Read only; the round's route is saved with its specification.
 */
router.get('/:id/routings', async (req, res) => {
  const request = await prisma.sampleRequest.findUnique({
    where: { id: req.params.id },
    select: { styleId: true },
  })
  if (!request) throw new AppError('Sample request not found', 404, 'NOT_FOUND')
  const routings = request.styleId ? await routingsFor(prisma, [request.styleId]) : []
  res.json({
    success: true,
    data: routings.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      version: r.version,
      style: r.style,
      category: r.category,
      applies: r.applies,
      problem: r.problem,
      steps: r.steps.length,
    })),
  })
})
/** One routing's steps as a round's route rows, without rates. */
router.get('/:id/routings/:routingId/steps', async (req, res) => {
  const request = await prisma.sampleRequest.findUnique({
    where: { id: req.params.id },
    select: { id: true },
  })
  if (!request) throw new AppError('Sample request not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: await routingAsRoute(prisma, req.params.routingId) })
})
router.get('/:id', async (req: AuthRequest, res) =>
  res.json({
    success: true,
    data: visible(await prisma.$transaction((tx) => sampleDetail(tx, req.params.id), T), req),
  })
)
router.post('/:id/actions', async (req: AuthRequest, res) => {
  const cmd = sampleActionSchema.parse(req.body)
  const after: SampleAfterCommit = { removeObjects: [] }
  const row = await prisma.$transaction(
    (tx) => actOnSample(tx, req.params.id, cmd, req.user!, after),
    T
  )
  // Files whose rows went with the committed action. Best effort: a file left
  // behind only wastes space, while its row is already gone.
  for (const path of after.removeObjects) await removeObject(path).catch(() => {})
  await writeAuditLog(req, {
    module: 'sampling',
    action: cmd.action === 'DECIDE' ? 'APPROVE' : 'UPDATE',
    entityType: 'SampleRequest',
    entityId: row.id,
    // The round the event names: for a file, its own round, not the one on screen.
    after: { version: row.version, action: cmd.action, roundId: after.eventRoundId ?? null },
  })
  // A style made or changed here is a masters record like any other, and its
  // history is looked for under its own name, before and after in full.
  if (after.styleAudit)
    await writeAuditLog(req, {
      module: 'masters',
      action: after.styleAudit.action,
      entityType: 'Style',
      entityId: after.styleAudit.styleId,
      before: after.styleAudit.before,
      after: after.styleAudit.after,
    })
  // What the action allowed but the screen should say: a route with no check.
  res.json({ success: true, data: visible(row, req), warnings: after.warnings ?? [] })
})
export default router
