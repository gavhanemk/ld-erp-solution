import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { processRanks } from './itemGroups.service'

/*
 * Each process's own floor: a stock location where the work in progress at
 * that process is kept, size by size (Cutting Floor, Stitching Floor…). It is
 * an ordinary location to everything else in the ERP, linked to its process,
 * and made the first time anything is put on it.
 */

type Db = Prisma.TransactionClient | typeof prisma

/** The floor of a process, made the first time it is needed. */
export async function floorFor(tx: Prisma.TransactionClient, departmentId: string) {
  const found = await tx.warehouse.findUnique({ where: { departmentId } })
  if (found) return found
  const dept = await tx.department.findUnique({
    where: { id: departmentId },
    select: { name: true, code: true, companyId: true },
  })
  if (!dept) throw new AppError('That process does not exist.', 404, 'NOT_FOUND')
  let code = `FLR-${dept.code}`
  for (let n = 2; await tx.warehouse.findUnique({ where: { code } }); n++) code = `FLR-${dept.code}-${n}`
  return tx.warehouse.create({
    data: { companyId: dept.companyId, name: `${dept.name} Floor`, code, departmentId },
  })
}

/**
 * The processes in the order the floor works them (from the routings: each
 * process's average place along its routes), each with its floor if it has
 * one yet. A process is a department with a process under Routing Masters.
 */
export async function processLadder(db: Db = prisma) {
  const [departments, ranks] = await Promise.all([
    db.department.findMany({
      where: { isActive: true, operations: { some: { isActive: true } } },
      select: { id: true, name: true, code: true, floor: { select: { id: true, name: true, code: true } } },
    }),
    processRanks(),
  ])
  return departments
    .map((d) => ({ ...d, rank: ranks.get(d.id) ?? 2 }))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map(({ rank: _rank, ...d }) => d)
}
