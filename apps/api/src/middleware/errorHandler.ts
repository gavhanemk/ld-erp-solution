import { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger'

export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  logger.error(`${req.method} ${req.path} — ${err.message}`, {
    stack: err.stack,
    body: req.body,
  })

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      code: err.code,
    })
  }

  /*
   * The database could not be reached, or dropped the connection mid-request.
   *
   * Supabase's pooler does this for a minute or two now and then. Unmapped,
   * it reached the screen as Prisma's own text — "Invalid
   * `tx.purchaseNoteLine.findMany()` invocation … Server has closed the
   * connection" — which reads as the system being broken rather than a
   * moment's outage, and on the live site as a bare "Internal server error".
   * Not retried here: a save might already have gone through, and only the
   * person at the screen can tell.
   */
  const prismaCode = (err as { code?: string }).code
  if (
    err.name === 'PrismaClientInitializationError' ||
    ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(prismaCode ?? '') ||
    /closed the connection|can't reach database|timed out fetching a new connection/i.test(
      err.message
    )
  ) {
    return res.status(503).json({
      success: false,
      message:
        'Lost the connection to the database for a moment. Wait a few seconds, then reopen or try again — check whether anything you saved went through.',
      code: 'DB_UNAVAILABLE',
    })
  }

  // Prisma errors
  if (err.name === 'PrismaClientKnownRequestError') {
    const prismaErr = err as any
    if (prismaErr.code === 'P2002') {
      return res.status(409).json({
        success: false,
        message: `${prismaErr.meta?.target} already exists`,
        code: 'DUPLICATE_ENTRY',
      })
    }
    if (prismaErr.code === 'P2025') {
      return res.status(404).json({
        success: false,
        message: 'Record not found',
        code: 'NOT_FOUND',
      })
    }
    /*
     * A foreign key refusing to let go of a row something else is built on.
     *
     * Several relations through the purchase chain are `Restrict` deliberately
     * — the bill line a note adjusts, the receipt line a bill claims, the
     * order line a receipt was booked against — so that the database is the
     * last line of defence when a guard above it is missed. Unmapped, that
     * refusal fell through to the generic 500 and told the person at the
     * screen the system had broken, when what actually happened is that the
     * record is spoken for and the answer is to deal with the other document
     * first.
     *
     * Deliberately vague about which document. The constraint gives a column
     * name, not a document number, and guessing a friendly noun from it is how
     * a message ends up naming the wrong thing. The routes that know name it
     * properly; this is the net underneath them.
     */
    if (prismaErr.code === 'P2003') {
      return res.status(409).json({
        success: false,
        message:
          'Another document is still built on this record, so it cannot be changed or removed. Cancel that document first.',
        code: 'IN_USE',
      })
    }
  }

  // Validation errors (Zod)
  if (err.name === 'ZodError') {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: (err as any).errors,
      code: 'VALIDATION_ERROR',
    })
  }

  return res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    code: 'INTERNAL_ERROR',
  })
}
