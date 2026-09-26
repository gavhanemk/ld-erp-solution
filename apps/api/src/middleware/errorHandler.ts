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
