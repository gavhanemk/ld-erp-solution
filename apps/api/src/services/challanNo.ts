import type { Prisma } from '@prisma/client'

/*
 * A department's challan number on an order: the department's process code,
 * the order, and a running number — CUT/2627-0002/01 is the first cutting
 * challan on MO-2627-0002, STI/2627-0001/03 the third stitching sent on from
 * MO-2627-0001. Read at a glance: which department, which order, which challan.
 *
 * The code is the Process master's, without its "OP-" (OP-CUT gives CUT), so a
 * shorter code there gives a shorter number here. Everything one department
 * issues on one order — cutting orders and the transfers it sends on — takes
 * the next number in that department's run, so no two of them share a number.
 * Called under the order's lock, which keeps two people from taking the same one.
 */

type Tx = Prisma.TransactionClient

/** OP-CUT → CUT; anything but letters and digits dropped. */
export const processCode = (code: string | null | undefined, fallback: string) =>
  (code ?? '')
    .trim()
    .toUpperCase()
    .replace(/^OP-/, '')
    .replace(/[^A-Z0-9]/g, '') || fallback

/** The next challan number for the department at `stepId` — or, with `kind`, at the order's step of that kind. */
export async function nextChallanNo(tx: Tx, mo: { id: string; moNumber: string }, at: { stepId: string } | { kind: 'CUTTING' }) {
  const step =
    'stepId' in at
      ? await tx.mOStep.findUnique({ where: { id: at.stepId }, select: { name: true, operation: { select: { code: true } } } })
      : await tx.mOStep.findFirst({ where: { moId: mo.id, kind: at.kind }, orderBy: { sequence: 'asc' }, select: { name: true, operation: { select: { code: true } } } })
  const code = processCode(step?.operation.code, 'kind' in at ? 'CUT' : processCode(step?.name, 'GEN'))
  const prefix = `${code}/${mo.moNumber.replace(/^MO-/, '')}/`
  const [transfers, cuttings] = await Promise.all([
    tx.processTransfer.findMany({ where: { transferNumber: { startsWith: prefix } }, select: { transferNumber: true } }),
    tx.cuttingOrder.findMany({ where: { cutOrderNumber: { startsWith: prefix } }, select: { cutOrderNumber: true } }),
  ])
  const taken = [...transfers.map((t) => t.transferNumber), ...cuttings.map((c) => c.cutOrderNumber)].map((n) => Number(n.slice(prefix.length)) || 0)
  return `${prefix}${String(Math.max(0, ...taken) + 1).padStart(2, '0')}`
}
