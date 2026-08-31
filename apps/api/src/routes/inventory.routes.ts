import { Router } from 'express'
import { AppError } from '../middleware/errorHandler'

/**
 * Stock. Not built.
 *
 * These used to answer with an empty array and success: true, which is a lie
 * that costs a day — a screen showing "no items in stock" is indistinguishable
 * from a working feature on an empty database, so nobody discovers the module
 * does not exist until they have finished building against it.
 *
 * Refusing outright is the honest answer, and it is what
 * docs/03-build-rules.md requires.
 *
 * When this is built it needs to hold, in this order: a stock ledger where the
 * balance is the sum of the movements rather than a number somebody keeps
 * updating, movements only ever created by a document, and stock that can never
 * go negative. See docs/04-business-rules.md.
 */

const router = Router()

const notBuilt = (what: string) => () => {
  throw new AppError(
    `${what} is not built yet. It will appear here as soon as it is ready.`,
    501,
    'NOT_IMPLEMENTED',
  )
}

router.get('/stock', notBuilt('Stock'))
router.get('/ledger', notBuilt('The stock ledger'))
router.get('/requisitions', notBuilt('Material requisitions'))

export default router
