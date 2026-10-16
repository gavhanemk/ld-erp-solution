import type { Prisma, PrismaClient } from '@prisma/client'
import { stepFigures } from './floor.service'
import { runKey, withOccurrence, type StepState } from './styleTrack.service'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * A style's orders one at a time: where each has got to on its own route, as
 * the floor's stage sheets show it.
 *
 * The style's page adds every order together — a step is done only when every
 * order is through it — which on its own does not say which order is where.
 * These are the same figures from the same place (`stepFigures`, as the style
 * tracker reads them), per order line, with the order's own steps: an order
 * keeps the copy of the route it was planned with, so it can differ from the
 * routing as it is now. A completed order counts as through every step it did
 * not leave out, as the style's figures count it.
 */
export async function styleOrderStages(db: Db, styleId: string) {
  const lines = await db.mOLine.findMany({
    where: { styleId },
    select: {
      id: true,
      color: true,
      totalQty: true,
      mo: {
        select: {
          id: true,
          moNumber: true,
          status: true,
          steps: {
            select: {
              id: true,
              sequence: true,
              operationId: true,
              kind: true,
              isQcStep: true,
              skippedAt: true,
              name: true,
              execution: true,
              ratePerPiece: true,
              department: { select: { name: true } },
              workstation: { select: { name: true } },
            },
          },
        },
      },
    },
    orderBy: { mo: { createdAt: 'desc' } },
  })

  const out = []
  for (const line of lines) {
    const own = [...line.mo.steps].sort((a, b) => a.sequence - b.sequence)
    const staged = own.length > 0
    const finished = line.mo.status === 'COMPLETED'
    const figures = staged ? new Map((await stepFigures(db, line.mo.id, own, line.totalQty, line.id)).map((x) => [x.stepId, x])) : new Map()
    const steps = withOccurrence(own).map((s) => {
      const x = figures.get(s.id)
      const state = (x?.state ?? 'NOT_STARTED') as StepState
      return {
        key: runKey(s.operationId, s.occurrence),
        name: s.name,
        kind: s.kind,
        isQcStep: s.isQcStep || s.kind === 'QC',
        execution: s.execution,
        department: s.department?.name ?? null,
        workstation: s.workstation?.name ?? null,
        ratePerPiece: s.ratePerPiece == null ? null : Number(s.ratePerPiece),
        state: (finished && state !== 'SKIPPED' ? 'DONE' : state) as StepState,
        completed: x?.completed ?? 0,
      }
    })
    const live = steps.filter((s) => s.state !== 'SKIPPED')
    const at = live.find((s) => s.state !== 'DONE') ?? null
    out.push({
      lineId: line.id,
      moId: line.mo.id,
      moNumber: line.mo.moNumber,
      status: line.mo.status,
      color: line.color,
      planned: line.totalQty,
      staged,
      finished,
      /** Left out of the style's figures, as everywhere that counts what is planned. */
      counted: line.mo.status !== 'CLOSED',
      done: live.filter((s) => s.state === 'DONE').length,
      total: live.length,
      /** The first step it is not through yet; none when every step is done, or nothing is staged. */
      at: at ? { key: at.key, name: at.name, completed: at.completed, state: at.state } : null,
      steps,
    })
  }
  return out
}
