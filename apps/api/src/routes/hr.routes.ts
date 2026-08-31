import { Router } from 'express'
import { AppError } from '../middleware/errorHandler'

/**
 * HR and payroll. Not built.
 *
 * Answered with an empty array before, which is indistinguishable from a mill
 * with no employees — see the note in inventory.routes.ts and
 * docs/03-build-rules.md.
 */

const router = Router()

const notBuilt = (what: string) => () => {
  throw new AppError(
    `${what} is not built yet. It will appear here as soon as it is ready.`,
    501,
    'NOT_IMPLEMENTED',
  )
}

router.get('/employees', notBuilt('The employee list'))
router.get('/attendance', notBuilt('Attendance'))
router.get('/payroll', notBuilt('Payroll'))

export default router
