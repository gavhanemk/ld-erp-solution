import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { requirePermission } from '../middleware/auth'
import { billedThisYear, termsOn } from '../services/tds.service'

/**
 * TDS for the expense bill form: the sections with the rate in force on the
 * bill's date, and what this supplier has billed so far this year.
 *
 * Under purchase rather than settings, because the person booking a bill
 * needs to read the sections without being allowed to change them.
 */
const router = Router()
const MODULE = 'purchase'

/**
 * A `yyyy-mm-dd` from the query, or today — read as midnight UTC, the way a
 * bill's own date is stored, so the rate shown is the rate the bill gets.
 */
const dateFrom = (v: unknown) => {
  const d = typeof v === 'string' && v ? new Date(v) : new Date()
  return Number.isNaN(d.getTime()) ? new Date() : d
}

router.get('/sections', requirePermission(MODULE, 'view'), async (req, res) => {
  const date = dateFrom(req.query.date)
  const sections = await prisma.tdsSection.findMany({
    where: { isActive: true },
    include: { rates: true },
    orderBy: [{ section: 'asc' }, { label: 'asc' }],
  })

  res.json({
    success: true,
    data: sections.map((s) => {
      const t = termsOn(s, date)
      return {
        ...t,
        id: s.id,
        isDefault: s.isDefault,
        name: `${t.section} — ${t.label} (${t.rate}%)`,
      }
    }),
  })
})

router.get('/year-to-date', requirePermission(MODULE, 'view'), async (req, res) => {
  const supplierId = typeof req.query.supplierId === 'string' ? req.query.supplierId : ''
  if (!supplierId) {
    res.json({ success: true, data: { taxable: 0, bills: 0, year: '' } })
    return
  }
  const data = await billedThisYear(prisma, {
    supplierId,
    sectionId: typeof req.query.sectionId === 'string' ? req.query.sectionId : null,
    date: dateFrom(req.query.date),
    excludeBillId: typeof req.query.excludeBillId === 'string' ? req.query.excludeBillId : null,
  })
  res.json({ success: true, data })
})

export default router
