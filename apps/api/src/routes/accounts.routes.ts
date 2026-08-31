import { Router } from 'express'
import { AppError } from '../middleware/errorHandler'

/**
 * Accounts. Not built.
 *
 * Answered with an empty array before, which reads on screen as "no vouchers
 * yet" rather than "this does not exist" — see the note in inventory.routes.ts
 * and docs/03-build-rules.md.
 *
 * Money owed and money due are already answered, by /sales/outstanding and the
 * dashboard summary. What is missing here is the ledger itself: vouchers,
 * payments against invoices, and the GST returns.
 */

const router = Router()

const notBuilt = (what: string) => () => {
  throw new AppError(
    `${what} is not built yet. It will appear here as soon as it is ready.`,
    501,
    'NOT_IMPLEMENTED',
  )
}

router.get('/vouchers', notBuilt('Vouchers'))
router.get('/ledger', notBuilt('The accounts ledger'))
router.get('/gst', notBuilt('GST reports'))

export default router
