import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission } from '../middleware/auth'
import { normaliseGarmentCode } from '../services/garment.service'
import { customerTrace, garmentTrace, orderTrace, search, styleTrace } from '../services/trace.service'
import { garmentDetail } from './garments.routes'

/*
 * Track & trace: look anything up — a tag, an order, a style, a customer —
 * and see its whole story in one place. Reads only.
 */

const router = Router()
const MODULE = 'inventory'

router.get('/search', requirePermission(MODULE, 'view'), async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  res.json({ success: true, data: await search(q) })
})

/** One garment, by the code on its tag: everything that ever happened to it. */
router.get('/garment/:code', requirePermission(MODULE, 'view'), async (req, res) => {
  const code = normaliseGarmentCode(decodeURIComponent(req.params.code))
  const g = await prisma.garment.findUnique({ where: { code }, select: { id: true, moId: true, dcId: true } })
  if (!g) throw new AppError(`No garment with the code ${code}. Check the tag, or type the number printed on it.`, 404, 'NOT_FOUND')
  res.json({ success: true, data: await garmentTrace(g.id, g.moId, g.dcId, garmentDetail) })
})

router.get('/order/:kind/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const kind = z.enum(['SO', 'MO']).parse(req.params.kind)
  res.json({ success: true, data: await orderTrace(kind, req.params.id) })
})

router.get('/customer/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  res.json({ success: true, data: await customerTrace(req.params.id) })
})

router.get('/style/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  res.json({ success: true, data: await styleTrace(req.params.id) })
})

export default router
