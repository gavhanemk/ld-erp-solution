import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { z } from 'zod'
import { requirePermission, userCan, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { createSampleSchema, sampleActionSchema } from '../schemas/sampling.schemas'
import {
  actOnSample,
  createSample,
  sampleDetail,
  sampleLookups,
} from '../services/sampling.service'

const router = Router()
/** The pilot must never point at the shared database, even with the flag set. */
export function samplingEnabled() {
  if (process.env.SAMPLING_ENABLED !== 'true' || process.env.NODE_ENV === 'production') return false
  return ['DATABASE_URL', 'DIRECT_URL'].every((k) => {
    try {
      const u = new URL(process.env[k] ?? '')
      return (
        ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && u.pathname === '/lderp_sampling'
      )
    } catch {
      return false
    }
  })
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
  if (userCan(req.user, 'accounts', 'view')) return row
  return {
    ...row,
    rounds: row.rounds.map((r) => ({
      ...r,
      materials: r.materials.map(({ issuedValue, returnedValue, ...m }) => m),
    })),
  }
}
router.get('/lookups', async (_req, res) =>
  res.json({ success: true, data: await prisma.$transaction(sampleLookups, T) })
)
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
    return { request: visible(request, req), company, lookups }
  }, T)
  res.json({ success: true, data })
})
router.get('/:id', async (req: AuthRequest, res) =>
  res.json({
    success: true,
    data: visible(await prisma.$transaction((tx) => sampleDetail(tx, req.params.id), T), req),
  })
)
router.post('/:id/actions', async (req: AuthRequest, res) => {
  const cmd = sampleActionSchema.parse(req.body)
  const row = await prisma.$transaction((tx) => actOnSample(tx, req.params.id, cmd, req.user!), T)
  await writeAuditLog(req, {
    module: 'sampling',
    action: cmd.action === 'DECIDE' ? 'APPROVE' : 'UPDATE',
    entityType: 'SampleRequest',
    entityId: row.id,
    after: { version: row.version, action: cmd.action, roundId: cmd.roundId },
  })
  res.json({ success: true, data: visible(row, req) })
})
export default router
