import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission } from '../middleware/auth'
import { normaliseGarmentCode } from '../services/garment.service'
import { customerTrace, filterOptions, findPieces, garmentTrace, orderTrace, search, styleTrace } from '../services/trace.service'
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

/** What the filters can offer: customers, orders, styles, colours and sizes that have tagged pieces. */
router.get('/filters', requirePermission(MODULE, 'view'), async (_req, res) => {
  res.json({ success: true, data: await filterOptions() })
})

/** Tagged pieces by any of the filters, and by what is typed. */
router.get('/pieces', requirePermission(MODULE, 'view'), async (req, res) => {
  const s = (k: string) => (typeof req.query[k] === 'string' && req.query[k] ? (req.query[k] as string) : undefined)
  const status = s('status')
  if (status && !['IN_STOCK', 'PACKED', 'DISPATCHED', 'SCRAPPED', 'VOID'].includes(status)) throw new AppError('Unknown status', 400, 'BAD_STATUS')
  res.json({
    success: true,
    data: await findPieces({
      q: s('q'),
      customerId: s('customerId'),
      styleId: s('styleId'),
      soId: s('soId'),
      moId: s('moId'),
      color: s('color'),
      sizeId: s('sizeId'),
      status,
      from: s('from'),
      to: s('to'),
      page: Number(s('page')) || 1,
    }),
  })
})

/** One garment, by the code on its tag: everything that ever happened to it. */
router.get('/garment/:code', requirePermission(MODULE, 'view'), async (req, res) => {
  const code = normaliseGarmentCode(decodeURIComponent(req.params.code))
  const g = await prisma.garment.findUnique({ where: { code }, select: { id: true, moId: true, dcId: true, mo: { select: { soId: true } } } })
  if (!g) throw new AppError(`No garment with the code ${code}. Check the tag, or type the number printed on it.`, 404, 'NOT_FOUND')
  res.json({ success: true, data: await garmentTrace(g.id, g.moId, g.mo.soId, g.dcId, garmentDetail) })
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
